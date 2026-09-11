/**
 * 路由与页面装配。没有依赖，也没有副作用：`server.js` 负责监听，`server.test.js` 直接调用
 * `route()`，所以跑测试不需要占用端口。
 *
 * 路由：`/` 首页、`/f/<功能 ID>` 功能页、`/usage` 使用数据 JSON。
 */
import { createServer } from 'node:http';
import { usage } from './usage.js';
import { home } from './page-home.js';
import { handover } from './page-handover.js';
import { bulkexport } from './page-bulkexport.js';
import { archive } from './page-archive.js';
import { sharelink } from './page-sharelink.js';
import { taxreport } from './page-taxreport.js';

/** 五个功能页，键就是 `/usage` 里的功能 ID。 */
export const pages = { handover, bulkexport, archive, sharelink, taxreport };

const html = 'text/html; charset=utf-8';

export function route(path) {
  if (path === '/') return { status: 200, type: html, body: home.render(pages) };
  if (path === '/usage') return { status: 200, type: 'application/json', body: JSON.stringify(usage, null, 2) };
  const match = /^\/f\/([a-z]+)$/.exec(path);
  const page = match ? pages[match[1]] : undefined;
  if (page) return { status: 200, type: html, body: page.render() };
  return { status: 404, type: 'text/plain; charset=utf-8', body: '没有这个页面' };
}

export function createApp() {
  return createServer((req, res) => {
    const answer = route(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    res.writeHead(answer.status, { 'content-type': answer.type });
    res.end(answer.body);
  });
}
