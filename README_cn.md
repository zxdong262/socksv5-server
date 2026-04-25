# socksv5-server

[English](./README.md) | 中文

基于 [socksv5](https://github.com/mscdex/socksv5)（原作者 [Brian White / mscdex](https://github.com/mscdex)）的现代 TypeScript 重写版本，零运行时依赖。主要用于替代 [electerm](https://github.com/electerm/electerm) SSH 隧道中的 `socksv5-electron` 包。

## 功能特性

- **SOCKS5 服务端** — 接受并代理连接，支持拦截（用于 SSH 隧道自定义管道）
- **SOCKS5 客户端** — 通过 SOCKS5 代理服务器建立连接
- **认证方式** — 内置无认证（`0x00`）和用户名/密码认证（`0x02`）
- **HTTP/HTTPS Agent** — 通过 SOCKS5 路由 `http`/`https` 请求
- **零运行时依赖** — 仅使用 Node.js 内置模块
- **TypeScript** — 包含完整类型声明
- **双格式输出** — 同时支持 CommonJS 和 ES Module
- **Node.js 16+** 兼容

## 致谢

本包是对 **[socksv5](https://github.com/mscdex/socksv5)** 的 TypeScript 重写，原版由 **[Brian White (mscdex)](https://github.com/mscdex)** 创作，遵循 MIT 协议。

本次重写所做的主要改进：
- 使用 TypeScript 完整重写，包含严格类型定义
- 将已废弃的 `new Buffer()` 替换为 `Buffer.alloc()` / `Buffer.from()`
- 将 `inherits(Class, EventEmitter)` 原型链替换为原生 ES6 `class extends EventEmitter`
- 移除 `ipv6` npm 依赖，改用 Node.js 内置 API 处理 IPv6 解析
- 添加完整的 JSDoc 文档注释
- 支持 CJS/ESM 双格式构建输出
- 添加 vitest 测试套件

## 安装

```bash
npm install socksv5-server
```

## 使用方法

### SSH 动态转发（SSH 隧道）

这是本包的主要使用场景，在 electerm 中用于 SSH 动态端口转发（替代 `socksv5-electron`）：

```ts
import { createServer, auth } from 'socksv5-server';

function dynamicForward({ conn, sshTunnelLocalPort, sshTunnelLocalHost = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const dproxyServer = createServer((info, accept, deny) => {
      conn.forwardOut(
        info.srcAddr, info.srcPort,
        info.dstAddr, info.dstPort,
        (err, stream) => {
          if (err) { deny(); return; }
          const clientSocket = accept(true);
          if (clientSocket) {
            stream.pipe(clientSocket).pipe(stream);
          }
        }
      );
    });

    dproxyServer.on('error', reject);
    dproxyServer.listen(sshTunnelLocalPort, sshTunnelLocalHost, () => {
      resolve(1);
    }).useAuth(auth.NoneAuth());

    conn.on('close', () => dproxyServer.close());
  });
}
```

### SOCKS5 服务端（基础示例）

```ts
import { createServer, auth } from 'socksv5-server';

// 创建无认证的 SOCKS5 服务端
const server = createServer((info, accept, deny) => {
  console.log(`连接请求: ${info.srcAddr}:${info.srcPort} → ${info.dstAddr}:${info.dstPort}`);

  if (info.dstPort === 22) {
    deny(); // 禁止连接 SSH 端口
    return;
  }

  accept(); // 透明代理
});

server.useAuth(auth.NoneAuth());
server.listen(1080, '127.0.0.1', () => {
  console.log('SOCKS5 代理已在 127.0.0.1:1080 启动');
});
```

### 用户名/密码认证

```ts
import { createServer, auth } from 'socksv5-server';

const server = createServer((info, accept, deny) => {
  accept();
});

server.useAuth(
  auth.UserPasswordAuth((username, password, cb) => {
    // 验证用户名和密码
    cb(username === 'admin' && password === 'secret');
  })
);

server.listen(1080, '0.0.0.0');
```

### SOCKS5 客户端

```ts
import { Client, auth } from 'socksv5-server';

const client = new Client({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
});

client.useAuth(auth.NoneAuth());

client.connect({ host: 'example.com', port: 80 }, (socket) => {
  socket.write('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n');
  socket.pipe(process.stdout);
});

client.on('error', console.error);
```

### 一步连接（快捷方式）

```ts
import { connect, auth } from 'socksv5-server';

const client = connect(
  {
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
    host: 'example.com',
    port: 80,
    auths: [auth.NoneAuth()],
  },
  (socket) => {
    socket.write('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n');
    socket.pipe(process.stdout);
  },
);
```

### HTTP Agent

```ts
import http from 'http';
import { HttpAgent, auth } from 'socksv5-server';

const agent = new HttpAgent({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
  auths: [auth.NoneAuth()],
});

http.get({ host: 'example.com', path: '/', agent }, (res) => {
  res.pipe(process.stdout);
});
```

### HTTPS Agent

```ts
import https from 'https';
import { HttpsAgent, auth } from 'socksv5-server';

const agent = new HttpsAgent({
  proxyHost: '127.0.0.1',
  proxyPort: 1080,
  auths: [auth.NoneAuth()],
});

https.get({ host: 'example.com', path: '/', agent }, (res) => {
  res.pipe(process.stdout);
});
```

## API 文档

### `createServer(options?, listener?)`

创建 SOCKS5 服务端实例。

返回：`Server`

### 连接事件监听器

```ts
(info: RequestInfo, accept: AcceptFn, deny: DenyFn) => void
```

| 参数 | 说明 |
|------|------|
| `info.srcAddr` | 客户端 IP 地址 |
| `info.srcPort` | 客户端端口 |
| `info.dstAddr` | 目标地址（IPv4/IPv6/域名） |
| `info.dstPort` | 目标端口 |
| `info.cmd` | `'connect'` \| `'bind'` \| `'udp'` |
| `accept(intercept?)` | 接受连接。传入 `true` 可获取原始 socket 进行自定义管道操作 |
| `deny()` | 拒绝连接（返回 DISALLOW 响应） |

### `server.useAuth(handler)`

注册认证处理器，支持链式调用。

### `class Client`

#### `client.useAuth(handler): this`

注册认证处理器。

#### `client.connect(options, cb?): this`

通过代理服务器连接目标地址。

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | `string` | `'localhost'` | 目标主机 |
| `port` | `number` | — | 目标端口（必填） |
| `localDNS` | `boolean` | `true` | 是否在本地进行 DNS 解析 |
| `strictLocalDNS` | `boolean` | `true` | DNS 解析失败时是否中止连接 |

### 认证处理器

#### `auth.NoneAuth()`

无认证方式（METHOD `0x00`），允许所有连接无需凭据。

#### `auth.UserPasswordAuth(verifier)`

服务端用户名/密码认证，`verifier` 为 `(user, pass, cb) => void`。

#### `auth.UserPasswordAuth(username, password)`

客户端用户名/密码认证，使用固定凭据。

## 开发命令

```bash
npm run build          # 构建 CJS + ESM 输出到 dist/
npm run test           # 运行测试（一次）
npm run test:watch     # 监听模式运行测试
npm run test:coverage  # 运行测试并生成覆盖率报告
npm run lint           # TypeScript 类型检查
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)

原版权所有 © 2013 Brian White。保留所有权利。  
重写版权所有 © 2024 zxdong262。
