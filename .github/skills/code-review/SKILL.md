---
name: code-review
description: 'Use when reviewing code changes — checks code quality, potential bugs, performance, security, and test coverage. Renders a strict red/yellow/green gate per item with an overall pass/fail verdict, aligning with the project DoD style. Load for "code review", "审查代码", "review this PR", "code quality", "代码质量" requests.'
argument-hint: "Provide the file paths or diff to review (or a feature/scope description)."
user-invocable: true
---

# Code Review Skill

对一组代码改动做**严格门禁**式审查。区别于轻量建议：每条检查项必须给**红 / 黄 / 绿**判定，并产出**整体 PASS / FAIL 结论**。

> 本项目**优先复用** `vibe-coding/skills/clean-code.md` 与 `vibe-coding/skills/frontend-design.md` 的规范，审查时**不重复**这两份文档中已公式化的标准（如 Tailwind 暗色文本色、SRP/KISS、命名见意、Guard Clause 等），而聚焦于「项目规范没覆盖、但同样致命」的项。

## When to Use

- 用户要求 review / 审查 / 评审一段代码、一次 PR、一个改动
- Coding Agent 在自评阶段（"do I have any latent issues?"）
- PR 合并前的最后一道把关
- 教学：帮助同事理解"为什么这段代码不该合"

## What It Does

逐项扫描改动，输出三件事：

1. **逐项 verdict**（红/黄/绿）+ 一句证据（`[file:line]` 形式）
2. **结构化问题清单**（严重 / 改进 / 优点）
3. **整体 PASS/FAIL**（FAIL 时给出阻塞项编号）

## Procedure

### 1. 明确审查范围

- 让用户提供：文件路径列表 / `git diff` / PR 编号 / 「刚才改动的代码」。
- 没有明确范围时，先用 `git diff --name-only HEAD~1` 或 `git status` 推断最近改动，避免对整个仓库大水漫灌。
- 对单文件 ≤300 行可全文读；超出则只读 diff + 关键调用方。

### 2. 加载项目规范（必须先读）

- `vibe-coding/skills/clean-code.md`（SRP/DRY/KISS/YAGNI、命名、改前先想依赖、SQL 走 `.bind()` 等）
- `vibe-coding/skills/frontend-design.md`（暗色模式文本色、间距层级、Tailwind 任意值禁用等）
- `CLAUDE.md`（本仓库技术栈、双部署隔离、双语、TS API 等）
- 与本次改动相关的 `docs/*.md` 计划文档（已确认的决策记录）

### 3. 逐项扫描（每项给 verdict）

| 类别            | 检查项                     | 红线条件（出现即 🔴）                                         |
| --------------- | -------------------------- | ------------------------------------------------------------- |
| **A. 正确性**   | 空指针 / Optional chaining | `obj.field` 链未判空就使用                                    |
|                 | 边界条件                   | 数组访问、循环边界、`Map.get` 返回 undefined 未处理           |
|                 | 异常处理                   | catch 后仅 `console.error` 吞掉、未回传上层、未影响事务一致性 |
|                 | 异步竞态                   | 同一资源并发写（缺 FOR UPDATE / 锁 / CAS）                    |
|                 | 类型与契约                 | 函数签名与调用方不一致、`any` 滥用、Promise 未 await          |
| **B. 性能**     | N+1 查询                   | 循环内 `await db.*`                                           |
|                 | 不必要重算                 | 在 `render` / 频繁路径上做 O(n) 计算而非 `useMemo`            |
|                 | 大对象                     | 返回值把整张大表传给前端而非分页                              |
| **C. 安全**     | SQL 注入                   | 字符串拼接 SQL；未走 `.bind()`                                |
|                 | 鉴权/权限                  | handler 缺 `withAuth` / `withAdmin`；service 缺项目访问校验   |
|                 | 敏感信息泄露               | 错误返回含 stack / SQL / 内部路径；公开端点回传用户标识       |
|                 | 密钥处理                   | API Key / 私钥明文入 DB 或日志；env 写进客户端 bundle         |
| **D. 规范一致** | 与本仓风格一致             | 见上「加载项目规范」                                          |
|                 | 命名见意                   | 缩写、魔数、布尔命名不是 `is/has/can` 形式                    |
|                 | 注释与代码一致             | 注释说一套、代码做一套；自解释代码被冗长注释遮挡              |
| **E. 工程**     | 改前先想依赖               | 改了被 import 的文件，但**未同步**所有调用方（断裂 import）   |
|                 | DB schema 漂移             | 改了 SQL 但 `SCHEMA.sql` 未对应更新；migrate 脚本缺幂等       |
|                 | 测试                       | 关键逻辑（计费、权限、幂等清理）完全无测试覆盖                |
|                 | 残留                       | 删除注释掉的代码、DEBUG console.log、临时调试路径             |

### 4. 渲染 verdict 表

```markdown
| 类别 | 检查项   | 判定 | 证据                                          |
| ---- | -------- | ---- | --------------------------------------------- |
| A    | 异常处理 | 🟡   | `[src/x.ts:42] catch 后仅 console.error 吞掉` |
| A    | 异步竞态 | 🔴   | `[src/y.ts:88] 并发写无 CAS`                  |
| B    | N+1      | 🟢   | —                                             |
```

> 判定说明：🟢 PASS / 🟡 WARNING（不阻塞但需关注）/ 🔴 FAIL（必须修才能合）。

### 5. 渲染结构化清单

```markdown
## 严重问题（🔴，阻塞合入）

- [file:line] 问题描述 + 风险 + 修法

## 改进建议（🟡）

- [file:line] 改法 + 推荐做法

## 优点

- 一句话点出值得肯定的实现

## 总体评价

- 一段话总结代码质量与本次改动风险
```

### 6. 给出整体结论

```markdown
## Verdict

🔴 **FAIL**（阻塞 N 项：#1 #3）/ 🟢 **PASS**（仅有 N 项改进建议）
```

## Decision Points

| 场景                                       | 判定                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| 改动在 `src/` 且涉及 SQL / 鉴权 / 计费     | **必须** 先跑 DoD：tsc 0、eslint 0、build 0 才有资格 PASS |
| 改动仅 docs / comment                      | 走轻量检查，verdict 表可只列相关几项                      |
| 用户只问"哪里不好"                         | 输出"严重问题 + 改进建议"两段，不必强求 verdict 表        |
| 审查不可逆操作（DROP/rm -rf/push --force） | **必标 🔴** 并要求二次确认                                |

## Quality Criteria (Self-Check)

- [ ] 每个 verdict 都附 `[file:line]` 证据，不能空口判定
- [ ] 严重问题有"为什么 + 怎么改"两部分
- [ ] 没有让"建议"伪装成"严重问题"刷存在感
- [ ] 整体 verdict 与逐项一致（红项数 = 0 时才能 PASS）
- [ ] 引用本仓规范时给出文件路径，让用户可复核

## Anti-patterns (DON'T)

- ❌ 通篇"看起来不错"、"可以优化"无具体证据
- ❌ 把"建议加个测试"当成严重问题（除非是关键路径）
- ❌ 忽略已有的本仓规范（重复 `clean-code` 已说的事）
- ❌ 对未改动文件挑刺（只审查本次 diff 范围）
- ❌ 一次性输出 50 条改进——按优先级，最多 10 条严重 + 10 条改进

## Reference

- 项目代码规范：`vibe-coding/skills/clean-code.md`
- 项目 UI 规范：`vibe-coding/skills/frontend-design.md`

## Example Invocation

```
/code-review src/services/assetGroups.ts src/app/api/admin/provider-credentials/route.ts
```

```
review this PR: https://github.com/.../pull/123
```

```
代码审查：刚才改的 /api/cron 路由与 canvas-presence 服务
```
