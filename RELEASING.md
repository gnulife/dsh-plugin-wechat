# 发布规范（开发者专用）

本文件是 dsh-plugin-wechat 的 npm 发布标准流程，普通用户无需阅读。

## 发布前置检查

- [ ] `node -v` >= 22，`npm whoami` 已登录
- [ ] 版本号符合 [语义化版本](https://semver.org/lang/zh-CN/)（`0.x` 开发期；`1.0.0` 首发正式）
- [ ] `package.json`：`name/version/description/files/bin/repository/license/keywords` 完整
- [ ] `files` 白名单只含：`dist`、`cordis.patch.yml`、`README.md`、`scripts`、`LICENSE`
- [ ] 仓库无硬编码密钥/token（密钥都在 `~/.dsh`、`~/.openclaw` 用户目录）
- [ ] `pnpm build` 通过，`dist/` 为最新

## 认证要求（npm 2026 新政）

直接 `npm publish` 必须满足二选一（官方文档：
[creating-and-publishing-unscoped-public-packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages)）：

1. **账号开启 2FA**（安全密钥/Passkey 模式）——CLI 发布时自动弹出认证；或
2. **Granular Access Token + Bypass 2FA**——创建于
   https://www.npmjs.com/settings/<user>/tokens ，包选 `dsh-plugin-wechat`、
   权限 Read and write、勾选 Bypass 2FA（需账号 2FA 开启时该选项才可用）

> classic token 已不被接受；npm 网页上传入口新版已移除；CI 推荐 OIDC Trusted Publishing。

## 发布步骤

```bash
# 1. 构建 + 预览包内容
pnpm build
npm pack --dry-run        # 检查文件清单，确认无多余/缺失

# 2. 本地试装（发布前必做）
npm pack
cd /tmp && npm init -y && npm i <项目路径>/dsh-plugin-wechat-<ver>.tgz
node -e "require('dsh-plugin-wechat')"   # 确认可加载

# 3. 正式发布（2FA 模式下会弹出认证）
npm publish

# 4. 验证
npm view dsh-plugin-wechat version
npm view dsh-plugin-wechat dist-tags --json
```

## 版本迭代（日常更新）

```bash
pnpm build
npm version patch   # 或 minor / major：自动改 version 并打 git tag
npm publish
git push --tags
```

每次发版在 README 或 CHANGELOG 记录变更。

## 撤销/废弃（谨慎）

- 错误发布且从未被安装：`npm unpublish dsh-plugin-wechat@<ver> --force`（24h 内）
- 有用户安装后：用 `npm deprecate dsh-plugin-wechat@<ver> "原因"` 而非 unpublish

## 安装链路自检（发布后）

```bash
npx -y dsh-plugin-wechat           # 一条命令全自动（装插件到 DSH + OpenClaw + 扫码 + 启动）
# 或分步：
dsh plugin --profile web add dsh-plugin-wechat
npx -y dsh-wechat-setup
```
