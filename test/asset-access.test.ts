import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
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
