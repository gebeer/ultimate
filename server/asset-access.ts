import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fromMapFileSource, fromSource } from 'convert-source-map'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isFileLoadingAllowed } from 'vite-plus'
import type { Plugin, ResolvedConfig } from 'vite-plus'

const contains = (root: string, file: string) => {
  const path = relative(root, file)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Only source trees are public, never the configuration/state beside extensions. */
export function assetAccess(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
  cacheDir: string,
): { allow: string[]; plugin: Plugin } {
  const privateRoots = [
    resolve(ultimateRoot, '.ultimate'),
    resolve(projectRoot, '.ultimate'),
    resolve(userHome, '.ultimate'),
    resolve(ultimateRoot, '.git'),
  ]
  const allow = [
    ultimateRoot,
    resolve(projectRoot, '.ultimate/extensions'),
    resolve(userHome, '.ultimate/extensions'),
    cacheDir,
  ]
  // The most specific root wins: a checkout may itself live inside ~/.ultimate.
  const rules = [
    ...privateRoots.map((root) => ({ root, allowed: false })),
    ...allow.map((root) => ({ root, allowed: true })),
  ].toSorted((a, b) => b.root.length - a.root.length)
  const allowed = (file: string) => rules.find(({ root }) => contains(root, file))?.allowed === true
  let config: ResolvedConfig
  const permitted = (file: string) => allowed(file) && isFileLoadingAllowed(config, file)
  const accessible = async (file: string) => {
    if (!permitted(resolve(file))) return false
    try {
      return permitted(await realpath(file))
    } catch (error) {
      // Missing files have no contents to disclose; keep Vite's normal fallback behaviour.
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
      throw error
    }
  }
  const assertAccessible = async (file: string) => {
    if (!(await accessible(file))) throw new Error('Asset access forbidden')
  }
  const checkMap = async (
    map: { sources?: string[]; sourceRoot?: string; sourcesContent?: (string | null)[] },
    file: string,
  ) => {
    // Mirror Vite's source-root resolution, but fail closed instead of reading from cwd.
    const root = await realpath(resolve(dirname(file), map.sourceRoot || ''))
    for (const [index, source] of (map.sources ?? []).entries()) {
      if (
        !source ||
        map.sourcesContent?.[index] != null ||
        source.includes('\0') ||
        /^(?:dep:|browser-external:|virtual:)/.test(source)
      )
        continue
      await assertAccessible(resolve(root, decodeURI(source).split(/[?#]/)[0]))
    }
  }
  return {
    allow,
    plugin: {
      name: 'ultimate:asset-access',
      enforce: 'pre',
      configResolved(resolved) {
        config = resolved
      },
      load: {
        order: 'pre',
        async handler(id) {
          // Server facets intentionally have filesystem access; this is a browser boundary.
          if (this.environment.name !== 'client') return
          const file = id.split(/[?#]/)[0]
          // React's refresh runtime is a plugin-generated module, not a filesystem path.
          if (!isAbsolute(file) || file === '/@react-refresh') return
          await assertAccessible(file)
          let code: string
          try {
            code = await readFile(file, 'utf8')
          } catch (error) {
            // Virtual or missing modules are handled by Vite's own loaders.
            if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
            throw error
          }
          // Vite reads authored maps and fills missing sourcesContent outside fs.allow checks.
          // Use its parser, checking external maps before reading and sources before injection.
          const converter =
            fromSource(code) ??
            (await fromMapFileSource(code, async (name) => {
              const path = resolve(dirname(file), name)
              await assertAccessible(path)
              return readFile(path, 'utf8')
            }))
          if (converter) await checkMap(converter.toObject(), file)
        },
      },
      transform: {
        order: 'post',
        async handler(_code, id) {
          if (this.environment.name !== 'client' || !isAbsolute(id)) return
          await checkMap(this.getCombinedSourcemap(), id.split(/[?#]/)[0])
        },
      },
      configureServer(server) {
        // Run before transforms, the module cache and public-file serving. Vite's fs.allow
        // alone trusts imported modules and does not check symlink targets or public files.
        const guard = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
          void (async () => {
            const path = decodeURIComponent((request.url ?? '/').split(/[?#]/)[0])
            // WHATWG URLs used downstream treat backslashes as path separators, even on Linux.
            if (path.includes('\\')) throw new Error('Invalid asset path')
            const filePath = path.startsWith('/@fs/')
              ? resolve('/', path.slice('/@fs/'.length))
              : path.startsWith('/@id/')
                ? path.slice('/@id/'.length)
                : undefined
            const files =
              filePath && isAbsolute(filePath)
                ? [resolve(filePath)]
                : [
                    resolve(server.config.root, '.' + path),
                    resolve(server.config.root, '.' + path + '.html'),
                    resolve(server.config.root, '.' + path, 'index.html'),
                    resolve(server.config.root, 'index.html'),
                    ...(server.config.publicDir
                      ? [resolve(server.config.publicDir, '.' + path)]
                      : []),
                  ]
            if ((await Promise.all(files.map(accessible))).every(Boolean)) return next()
            response.writeHead(403)
            response.end('Forbidden')
          })().catch(() => {
            response.writeHead(403)
            response.end('Forbidden')
          })
        }
        server.middlewares.use(guard)
        // configureServer's returned hook runs after HTML fallback, before index HTML is read.
        return () => server.middlewares.use(guard)
      },
    },
  }
}
