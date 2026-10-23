import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Plugin } from 'vite-plus'

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
  const accessible = async (file: string) => {
    if (!allowed(resolve(file))) return false
    try {
      return allowed(await realpath(file))
    } catch (error) {
      // Missing files have no contents to disclose; keep Vite's normal fallback behaviour.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }
  return {
    allow,
    plugin: {
      name: 'ultimate:asset-access',
      enforce: 'pre',
      async load(id) {
        // Server facets intentionally have filesystem access; this is a browser boundary.
        if (this.environment.name !== 'client') return
        const file = id.split(/[?#]/)[0]
        if (isAbsolute(file) && !(await accessible(file))) throw new Error('Asset access forbidden')
      },
      configureServer(server) {
        // Run before transforms, the module cache and public-file serving. Vite's fs.allow
        // alone trusts imported modules and does not check symlink targets or public files.
        server.middlewares.use((request, response, next) => {
          void (async () => {
            const path = decodeURIComponent((request.url ?? '/').split(/[?#]/)[0])
            const files = path.startsWith('/@fs/')
              ? [resolve('/', path.slice('/@fs/'.length))]
              : [
                  resolve(server.config.root, '.' + path),
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
        })
      },
    },
  }
}
