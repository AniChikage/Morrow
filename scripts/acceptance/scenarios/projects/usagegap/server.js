/**
 * `node server.js` 的入口：端口取自 `PORT`（缺省 8080），只监听 127.0.0.1，启动后把地址打到
 * stdout。所有路由在 `app.js` 里。
 */
import { createApp } from './app.js';

const port = Number(process.env.PORT || 8080);
createApp().listen(port, '127.0.0.1', function ready() {
  console.log(`listening http://127.0.0.1:${this.address().port}`);
});
