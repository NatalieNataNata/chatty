# Chatty · Private AI Radio

Chatty 是一个可运行的 macOS 私人 AI 电台。它会结合当前场景、播放记录和用户明确确认的偏好，完成节目策划、个性化选歌、AI DJ 英文播报与连续队列管理。项目包含独立桌面 App 和桌宠，不需要依赖浏览器作为产品外壳。

## 本地开发

安装依赖：

```bash
npm install
```

启动独立桌面 App：

```bash
npm run desktop:dev
```

如需分别调试服务端和 Web 界面，可使用 `npm run dev`。

复制 `.env.example` 为 `.env`，并填写 AI 模型、Fish Audio 以及可选代理配置。`.env` 、网易云会话、个人歌单数据与 TTS 缓存均不会进入 Git。

Chatty 只使用 Fish Audio 中指定的定制声音。任一必要配置缺失或 Fish 暂时不可用时，DJ 会保持静音，不会偷偷切换到系统声音。生成的播报缓存在本地 `data/tts/`。

仓库内准备好声音参考文件后，可运行 `npm run voice:create` 创建仅自己可见的 Fish Audio 声音模型。命令会返回需要写入 `.env` 的 `FISH_AUDIO_VOICE_ID`。

## 核心能力

- 网易云扫码登录、个人歌单同步与可播放音频解析
- AI 策划节目、动态生成英文开场与真实曲目串词
- 自动续补的长队列，以及基于跳过、播完等行为的当前会话自适应
- 偏好确认机制：隐式行为不会直接写入长期记忆
- Fish Audio 定制 AI DJ 声音，播报时自动压低音乐音量
- macOS 桌面 App、语音输入和独立桌宠
- SQLite 状态、对话、记忆与审计记录持久化

## 验证与打包

```bash
npm test --workspace @chatty/server
npm run build
npm run desktop:package
```
