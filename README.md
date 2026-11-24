# dsh-crew-morale

一个独立的通用 DSH 船员士气插件，与海洋背景插件完全解耦。界面全程不展示任何士气条或数值，仅通过 `dsh:status-text:override` 事件向 `dsh-rotate-status-text` 投递吐槽或低谷抗议，并通过 `/rum` 官方命令恢复士气与派发 `dsh:confetti` 事件。

## 独立安装与配置

```bash
dsh plugin --profile desktop add dsh-crew-morale
```

插件本身不含任何主题文案，通过 `cordis.patch.yml` 注入 `pack` 后生效，也可由整合包统一收口：

```yaml
- insert:
    - id: dsh-crew-morale
      name: 'dsh-crew-morale'
      config:
        initial: 100
        retryDelta: -4
        failedDelta: -12
        cancelledDelta: -3
        lowThreshold: 30
        rumTarget: 100
        pack:
          commandName: rum
          commandDescription:
            zh: 给船员发一轮朗姆酒，把士气拉满并放彩带
            en: Pour a round of rum to restore crew morale and fire confetti
          protestPhrases:
            zh: [船员们正敲着空酒桶抱怨不停]
            en: [The crew is banging empty rum casks in protest]
          retryPhrases:
            zh: [风向突变被迫重调航线，船员士气略降]
            en: [Course correction under crosswinds, crew grumbles]
          failedPhrases:
            zh: [上一仗船体吃了一记重炮，船员士气大跌]
            en: [Took a broadside last turn, morale drops]
          cancelledPhrases:
            zh: [刚才临时鸣金收兵，船员有点摸不着头脑]
            en: [Aborted mid-run, crew looks puzzled]
          rumPhrases:
            zh: [朗姆酒管够！全船水手又生龙活虎了！]
            en: [Rum for all hands! Spirits are soaring again!]
          confetti:
            colors: ['#f5c542', '#ffd966', '#ffffff']
            particleCount: 95
            spread: 78
```

## 配置项

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `initial` | `number` | `100` | 新会话初始士气值（仅存于内存，重启清零） |
| `retryDelta` | `number` | `-4` | 自动重试 `llm/retry-started` 时的变动值 |
| `failedDelta` | `number` | `-12` | 异常失败或超限 `turn/end` 时的变动值 |
| `cancelledDelta` | `number` | `-3` | 用户主动取消或中断 `turn/end` 时的变动值 |
| `lowThreshold` | `number` | `30` | 低于该阈值时触发状态栏低谷抗议插播 |
| `rumTarget` | `number` | `100` | 执行 `/rum` 后士气恢复的目标值 |
| `pack` | `false \| object` | `false` | 主题命令与多语言文案包；`false` 时不注册命令与轮询 |

## 跨插件事件契约

- 发出 `dsh:status-text:override`：低谷抗议（`priority: 20, ttlMs: 0, interleaveEvery: 2`）与临时吐槽（`priority: 30, ttlMs: 5000`）。
- 发出 `dsh:confetti`：每次执行 `/rum` 无冷却立即派发 `pack.confetti`（为空对象时由 `dsh-confetti` 使用自身配置默认值）。

## 许可

MIT
