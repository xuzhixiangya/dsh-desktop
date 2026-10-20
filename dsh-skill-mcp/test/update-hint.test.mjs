import assert from 'node:assert/strict'
import test from 'node:test'

// 这个包随桌面源码发布。updateHint 不询问 npm，也不报告可安装的新版本。
// DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK 仍表示这次检查被关掉。

function withFetch(run) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('update check must not use the network') }
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original
    if (calls !== 0) throw new Error(`fetch called ${calls} times, expected 0`)
  })
}

test('updateHint reports the installed source and no published upgrade', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  await withFetch(async () => {
    const result = await McpManagerGateway.prototype.updateHint.call({ ctx: {} })
    assert.equal(result.updateAvailable, false)
    assert.equal(result.latest, result.current)
    assert.equal(result.url, null)
  })
})

test('checkForUpdate does not ask npm or GitHub', async () => {
  const { checkForUpdate } = await import('../lib/index.js')
  await withFetch(async () => {
    const result = await checkForUpdate(Date.now(), true)
    assert.equal(result.updateAvailable, false)
    assert.equal(result.latest, result.current)
  })
})

test('checkForUpdate respects DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK without any request', async () => {
  const { checkForUpdate } = await import('../lib/index.js')
  process.env.DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK = '1'
  try {
    await withFetch(async () => {
      const result = await checkForUpdate(Date.now(), true)
      assert.equal(result.disabled, true)
      assert.equal(result.updateAvailable, false)
    })
  } finally {
    delete process.env.DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK
  }
})
