import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fromObject } from 'convert-source-map'
import { fixture } from './server-fixture.ts'

const dummy = 'SYNTHETIC_PRIVATE_VALUE'

test('serves source and extension assets, not private state or symlink targets', async () => {
  const { server, options } = await fixture(false, undefined, true)
  const { ultimateRoot, userHome } = options
  const userExtensions = join(userHome, '.ultimate/extensions/demo')
  const projectExtensions = join(ultimateRoot, '.ultimate/extensions/demo')
  const privateFile = join(userHome, '.ultimate/private-fixture.json')
  const projectPrivate = join(ultimateRoot, '.ultimate/private-fixture.json')
  const outside = join(userHome, 'outside.json')
  for (const directory of [userExtensions, projectExtensions, join(ultimateRoot, 'web/public')])
    await mkdir(directory, { recursive: true })
  for (const file of [privateFile, projectPrivate, outside])
    await writeFile(file, JSON.stringify({ value: dummy }))
  for (const directory of [userExtensions, projectExtensions]) {
    await writeFile(join(directory, 'web.tsx'), 'export default () => null')
    await writeFile(join(directory, 'asset.txt'), 'public asset')
    await symlink(privateFile, join(directory, 'linked.json'))
  }
  await symlink(privateFile, join(ultimateRoot, 'web/public/linked.json'))
  await symlink(privateFile, join(ultimateRoot, 'web/linked.json'))
  await symlink(privateFile, join(ultimateRoot, 'linked.json'))
  await writeFile(
    join(userExtensions, 'import.ts'),
    `import value from ${JSON.stringify(privateFile)}; export default value`,
  )
  const request = (path: string) => fetch(server.url + path)
  for (const directory of [userExtensions, projectExtensions]) {
    expect((await request('/@fs/' + join(directory, 'web.tsx'))).status).toBe(200)
    expect(await (await request('/@fs/' + join(directory, 'asset.txt'))).text()).toBe(
      'public asset',
    )
  }
  const denied = [
    ...[privateFile, projectPrivate, outside, join(ultimateRoot, 'linked.json')].flatMap((file) => [
      '/@fs/' + file,
      '/@fs/' + file + '?raw',
      '/@fs/' + file + '?import',
    ]),
    '/@fs/' + privateFile.replace('.ultimate', '%2eultimate'),
    '/@fs/' + userExtensions + '/%2e%2e/%2e%2e/private-fixture.json',
    '/@fs/' + join(userExtensions, 'linked.json'),
    '/@fs/' + join(projectExtensions, 'linked.json'),
    '/linked.json',
    '/public/linked.json',
  ]
  for (const path of denied) {
    const response = await request(path)
    expect({ path, status: response.status }).toEqual({ path, status: 403 })
    expect(await response.text()).not.toContain(dummy)
  }
  // Import analysis can mark a private path as a safe module. It must still be denied.
  await request('/@fs/' + join(userExtensions, 'import.ts'))
  expect((await request('/@fs/' + privateFile)).status).toBe(403)
  // Vite load hooks also guard server-side raw imports, before file contents are read.
  await expect(server.vite.transformRequest('/@fs/' + projectPrivate + '?raw')).rejects.toThrow(
    'Asset access forbidden',
  )
  expect((await request('/')).status).toBe(200)
  expect((await request('/api/models')).status).toBe(200)
})

test('rejects raw URL normalization, HTML fallbacks and wrapped optimized dependency paths', async () => {
  const { server, options } = await fixture(false, undefined, true)
  const { ultimateRoot, home } = options
  const privateFile = join(ultimateRoot, '.ultimate/private-fixture.json')
  await writeFile(privateFile, JSON.stringify({ value: dummy }))
  await symlink(privateFile, join(ultimateRoot, 'web/leak.html'))
  await mkdir(join(ultimateRoot, 'web/directory'))
  await symlink(privateFile, join(ultimateRoot, 'web/directory/index.html'))
  const cacheFile = join(home, 'vite/deps/linked.json')
  await mkdir(join(home, 'vite/deps'), { recursive: true })
  await symlink(privateFile, cacheFile)
  // node:http sends the raw path. fetch would normalize backslashes before sending it.
  const status = (path: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        server.url,
        { path, headers: { accept: 'text/html' } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end()
    })
  for (const path of [
    '/@fs/' + join(ultimateRoot, 'web') + '\\..\\.ultimate/private-fixture.json',
    '/@fs/' + privateFile.replaceAll('/', '%2f'),
    '/@fs/' + privateFile.slice(1),
    '/leak',
    '/directory/',
    '/@id/' + cacheFile + '?import',
  ])
    expect({ path, status: await status(path) }).toEqual({ path, status: 403 })
  await expect(server.vite.transformRequest('/@id/' + cacheFile + '?import')).rejects.toThrow(
    'Asset access forbidden',
  )
  expect((await fetch(server.url + '/@fs/' + join(ultimateRoot, 'web/index.html'))).status).toBe(
    200,
  )
})

test('does not inject private referenced source contents into browser source maps', async () => {
  const { server, options } = await fixture(false, undefined, true)
  const { ultimateRoot } = options
  const projectPrivate = join(ultimateRoot, '.ultimate/private-fixture.json')
  await writeFile(projectPrivate, JSON.stringify({ value: dummy }))
  const map = { version: 3, sources: [projectPrivate], names: [], mappings: 'AAAA' }
  const web = join(ultimateRoot, 'web')
  await symlink(projectPrivate, join(web, 'linked-source.json'))
  await symlink(join(ultimateRoot, '.ultimate'), join(web, 'linked-root'))
  await writeFile(join(ultimateRoot, '.env'), dummy)
  await writeFile(join(web, 'external.map'), JSON.stringify(map))
  const privateMap = join(ultimateRoot, '.ultimate/private.map')
  await writeFile(privateMap, JSON.stringify({ ...map, sourcesContent: [dummy] }))
  await symlink(privateMap, join(web, 'linked.map'))
  const comments = [
    fromObject(map).toComment(),
    fromObject(map).toComment({ encoding: 'uri' }),
    fromObject({ ...map, sources: ['linked-source.json'] }).toComment(),
    fromObject({
      ...map,
      sources: ['private-fixture.json'],
      sourceRoot: 'linked-root',
    }).toComment(),
    fromObject({
      ...map,
      sources: [projectPrivate.replace('.ultimate', '%2eultimate')],
    }).toComment(),
    fromObject({ ...map, sources: ['../.env'] }).toComment(),
    '//# sourceMappingURL=external.map',
    '//# sourceMappingURL=' + privateMap,
    '//# sourceMappingURL=linked.map',
  ]
  for (const [index, comment] of comments.entries()) {
    const path = `/unsafe-${index}.js`
    await writeFile(join(web, path), `export const value = 1\n${comment}`)
    await expect(server.vite.transformRequest(path)).rejects.toThrow('Asset access forbidden')
    const response = await fetch(server.url + path)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain(dummy)
  }
  // Valid authored maps retain their source contents instead of being stripped or disabled.
  await writeFile(join(web, 'original.js'), 'public original source')
  const safeMap = { ...map, sources: ['original.js'] }
  await writeFile(join(web, 'safe.map'), JSON.stringify(safeMap))
  for (const [index, comment] of [
    fromObject(safeMap).toComment(),
    '//# sourceMappingURL=safe.map',
  ].entries()) {
    const path = `/safe-${index}.js`
    await writeFile(join(web, path), `export const value = 1\n${comment}`)
    const result = await server.vite.transformRequest(path)
    expect(
      result?.map && 'sourcesContent' in result.map ? result.map.sourcesContent : [],
    ).toContain('public original source')
    expect((await fetch(server.url + path)).status).toBe(200)
  }
})
