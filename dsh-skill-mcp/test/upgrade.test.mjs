// 一键升级的判定闸门。
//
// 为什么值得单独一套：这个动作会**改用户机器上的安装**，而它的错误形态全是
// 「点了没反应」或「点了把本地开发链接换成 npm 包」——两种都不会让面板报错，
// 也看不出来。所以这里钉的是判定与失败文案，不是 UI。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__upgrade = { upgradePlan, upgradeFailureText, pnpmOutputTail, UPGRADE_PACKAGE };`,
)
assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

function loadUpgradeRule() {
  const react = {
    Fragment: Symbol('Fragment'),
    createElement() {},
    useCallback() {},
    useEffect() {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  }
  let client
  vm.runInNewContext(instrumentedClient, {
    console,
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: {},
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load(definition) {
          client = definition.factory((name) => {
            assert.equal(name, 'react')
            return react
          })
        },
      },
    },
  })
  return client.__upgrade
}

const service = { installBundle() {} }
// updateAvailable 由宿主算成「latest > current」（lib/index.js 的 compareVersions），
// 所以这里照它的口径造数据，不要单独造一个自相矛盾的组合。
const hint = (latest, current = '1.4.2') => ({ current, latest, updateAvailable: !!latest && latest !== current })
const npmBundle = { name: 'dsh-skill-mcp', source: '^1.4.2', installed: true, version: '1.4.2' }

test('an upgrade is never offered because this package is maintained from source', () => {
  const { upgradePlan } = loadUpgradeRule()
  const plan = upgradePlan({ service, hint: hint('1.5.0'), bundle: npmBundle })
  assert.equal(plan.supported, false)
  assert.equal(plan.reason, 'source-maintained')
  assert.equal(plan.spec, null)
  assert.equal(upgradePlan({ service: null, hint: hint('1.5.0'), bundle: npmBundle }).supported, false)
  assert.equal(upgradePlan({ service, hint: hint(null), bundle: npmBundle }).supported, false)
  assert.equal(upgradePlan({ service, hint: hint('1.4.2', '1.4.2'), bundle: npmBundle }).supported, false)
})

test('neither a registry spec nor a local link can replace the source copy', () => {
  const { upgradePlan } = loadUpgradeRule()
  for (const source of [
    'link:D:/sudy/github/dsh-mcp-manager-ui',
    'file:C:/tmp/dsh-mcp-manager-ui-1.5.0.tgz',
    'github:Imzl-zl/dsh-mcp-manager-ui#v1.5.0',
    'workspace:*',
    '^1.4.2',
    '1.4.2',
    '~1.4.2',
    'latest',
    '',
  ]) {
    const plan = upgradePlan({ service, hint: hint('1.5.0'), bundle: { ...npmBundle, source } })
    assert.equal(plan.supported, false, `${source || '(空 source)'} 不该被允许一键升级`)
    assert.equal(plan.reason, 'source-maintained')
    assert.equal(plan.spec, null)
  }
})

test('upgrade failures say what happened instead of just "failed"', () => {
  const { upgradeFailureText } = loadUpgradeRule()
  // 已知码给可操作的中文解释。
  assert.match(upgradeFailureText({ code: 'incompatible-version' }, 1), /不兼容/)
  assert.match(upgradeFailureText({ code: 'stop-profile' }, 1), /重启/)
  assert.match(upgradeFailureText({ code: 'management-required' }, 1), /托管/)
  // 未知码不吞：码与 pnpm 退出码都要带出来，否则用户和我们都无从查起
  // （desktop 直接改当前 profile 且没有自动回滚，失败后必须能追）。
  const unknown = upgradeFailureText({ code: 'brand-new-code' }, 7)
  assert.match(unknown, /brand-new-code/)
  assert.match(unknown, /7/)
  // 连码都没有时也要有话说，不能是空串。
  assert.ok(upgradeFailureText(null, null).length > 0)
})

test('an unknown failure carries pnpm own words, cleaned up', () => {
  const { upgradeFailureText, pnpmOutputTail } = loadUpgradeRule()
  // 真机实测过的那次失败：面板只显示一个 Windows 崩溃码，而 pnpm 原文说得很清楚。
  // 官方把整段输出放在 packageResult.output 里，所以要把它接上——但要挑干净。
  const output = [
    'Progress: resolved 4, reused 3, downloaded 0, added 3',
    'npm notice',
    'npm notice package size: 222.9 kB',
    '\u001b[31m[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for example-plugin@9.9.9\u001b[0m',
    '',
    'The latest release of example-plugin is "1.5.3".',
  ].join('\n')
  const text = upgradeFailureText({ code: 'operation-error' }, 3221226505, output)
  assert.match(text, /ERR_PNPM_NO_MATCHING_VERSION/, '必须把 pnpm 的原句带出来，否则只有崩溃码')
  assert.match(text, /The latest release/, 'pnpm 的结论行更该出现（它直接告诉用户"最新是什么"）')
  assert.match(text, /operation-error/)
  // 噪声与 ANSI 颜色码不该出现：横幅是给人看的，不是把日志贴上去。
  assert.doesNotMatch(text, /Progress:|npm notice|package size/)
  assert.doesNotMatch(text, /\u001b\[/, 'ANSI 颜色码要剥掉')
  // 已知码的解释优先：它已经把原因和下一步说清了，不该再被 pnpm 输出淹没。
  assert.equal(upgradeFailureText({ code: 'stop-profile' }, 1, output), '宿主正在停止，未升级；请重启后再试。')
  // 没有 output 时行为与改动前逐字一致（老宿主/老官方版本不带这个字段）。
  assert.equal(upgradeFailureText({ code: 'brand-new-code' }, 7), '升级失败（错误码 brand-new-code，pnpm 退出码 7）。')
  // 挑行本身：没有报错行时取末尾三行；有报错行时从它开始带（结论就在它后面一行）。
  assert.equal(pnpmOutputTail(''), '')
  assert.equal(pnpmOutputTail('a\nb\nc\nd\ne'), 'c d e')
  assert.equal(pnpmOutputTail('one\nERR_PNPM_X boom\n因为原因在这里\n还有一句'), 'ERR_PNPM_X boom 因为原因在这里 还有一句')
  assert.ok(pnpmOutputTail('x'.repeat(500)).length <= 300)
})

test('the post-upgrade banner survives the hint going away', () => {
  // 这是一个真机跑出来的缺陷，不是假想：升级成功后**宿主立刻报「已是最新」**（磁盘上的
  // package.json 已经被换成新版），于是 updateHint 变成 null——而横幅原本挂在 updateHint 上，
  // 结果「点完就消失」，用户永远看不到那句「重启宿主后生效」。而宿主代码在进程内执行，
  // 不重启等于没升级，这句话是整个功能的必要闭环。
  //
  // 所以横幅的存活条件必须把 done 也算进去。
  assert.match(
    clientSource,
    /\(updateHint \|\| upgradeState\.phase === 'done'\)/,
    '升级完成后 updateHint 已是 null，横幅必须靠 done 状态存活',
  )
  // done 分支不能再去读 updateHint 的字段（那时它是 null，会直接崩）。
  const doneBranch = clientSource.match(/phase === 'done' \? t\('已升级到 v\{version\}，重启宿主后生效', \{ version: ([^}]+) \}\)/)
  assert.ok(doneBranch, '找不到 done 分支的文案')
  assert.match(doneBranch[1], /upgradeState\.version/, 'done 文案只能用升级时记下的版本，不能读 updateHint')
  // running 阶段就要把版本记下来，否则 done 时没有版本可显示（updateHint 已刷新成「已是最新」）。
  // 记的来源是 plan.version——目标版本随判定一起出来，不依赖之后可能变空的 hint。
  assert.match(clientSource, /phase: 'running', version: plan\.version/, 'running 阶段要记住目标版本')
  assert.match(clientSource, /phase: 'done', version: plan\.version/, 'done 也要用同一个来源，不能读 hint')
  // 关闭按钮必须也能收掉 done 横幅，否则按了没反应。
  assert.match(clientSource, /current\.phase === 'done' \? \{ phase: 'idle' \}/, '关闭要能收掉 done 状态')
})

test('the upgrade path calls the official remote with the arguments it requires', () => {
  // 这条钉的是调用形状，不是判定：installBundle 的 wire 签名要求**两个**参数
  // （spec, options），少传一个会被直接拒绝：
  //   client api: pluginManager/installBundle expected 2 argument(s), got 1
  // 而 options 缺失时的报错发生在 wire 层，不会走到我们的分支，所以只能靠源码形状钉住。
  const call = clientSource.match(/svc\[UPGRADE_METHOD\]\(([^)]*)\)/)
  assert.ok(call, '找不到 installBundle 的调用点')
  assert.match(call[1], /plan\.spec/, '第一个参数必须是 spec')
  assert.match(call[1], /,\s*\{\}/, '第二个参数必须显式传（wire 要求两个参数）')
  // 结果分流：官方用 application 表达失败与「装上了但要重启」，不能只看 ok。
  assert.match(clientSource, /r\.application === 'failed'/)
  // 升级已存在的包时官方**无条件**返回 restart-required（installBundle 里的
  // `if (Object.hasOwn(before, name)) return 'restart-required'`），所以成功分支必须提示重启——
  // 宿主代码在进程内执行，不重启等于没升。这句文案就是整条链路的闭环。
  assert.match(clientSource, /t\('已升级到 v\{version\}，重启宿主后生效', \{ version: upgradeState\.version \}\)/)
})
