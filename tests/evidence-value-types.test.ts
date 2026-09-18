import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startReceiver } from './harness/receiver.ts';
import { computeMetrics } from '../scripts/acceptance/metrics.ts';
import type { ScalarRule } from '../service/strategy-types.ts';

const future = () => new Date(Date.now() + 3600000).toISOString();
const numeric: ScalarRule = { pointer: '', operator: 'gte', expected: 100 };
const cases: Array<{ name: string; data: unknown; rule: ScalarRule; verdict: 'met' | 'unknown' }> = [
  { name: 'numeric string', data: '123', rule: numeric, verdict: 'unknown' },
  { name: 'plain string', data: 'ok', rule: { pointer: '', operator: 'equals', expected: 'ok' }, verdict: 'met' },
  { name: 'encoded object', data: '{"count":123}', rule: { ...numeric, pointer: '/count' }, verdict: 'unknown' },
  { name: 'number', data: 123, rule: numeric, verdict: 'met' },
  { name: 'object', data: { count: 123 }, rule: { ...numeric, pointer: '/count' }, verdict: 'met' },
  { name: 'boolean', data: false, rule: { pointer: '', operator: 'equals', expected: false }, verdict: 'met' },
];

for (const source of ['file', 'watch', 'capture', 'http'])
  test(`evidence types survive ${source} sampling, review, preflight and metrics`, async (t) => {
    for (const example of cases)
      await t.test(example.name, async () => {
        const s = await startIsolated();
        const receiver = source === 'http' ? await startReceiver({ feedback: () => example.data }) : undefined;
        try {
          const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
          writeFileSync(join(s.path, 'value.json'), JSON.stringify(example.data));
          const watch =
            source === 'capture'
              ? undefined
              : await call('watch.create', {
                  title: '类型边界',
                  pointer: '',
                  condition: 'changed',
                  deadline: future(),
                  ...(receiver ? { url: receiver.url + '/metrics' } : { kind: 'file', path: 'value.json' }),
                });
          const context = await call('context');
          const d = await call('decision.choose', {
            objectiveVersion: context.strategy.objective.version,
            options: [
              {
                title: '核对值类型',
                kind: 'observe',
                benefit: '不误判通过',
                cost: '隔离采样',
                uncertainty: '无部署结论',
              },
            ],
            selected: 0,
            rationale: '原始类型必须保持',
            nextStep: '采样',
            expectedOutcome: '准确核对类型',
            evaluation: '真实服务复盘与预检',
            stopWhen: '数据类型不符',
            understandingRefs: [],
            evidenceIds: [],
            watchIds: watch ? [watch.id] : [],
            reviewAt: future(),
            maxRuns: 2,
            expectations: [
              {
                id: 'value',
                kind: 'outcome',
                claim: '按原值核对',
                scope: '隔离数据',
                verification: '检查实际类型',
                disconfirm: '字符串被解析为其他类型',
                deadline: future(),
                rule: example.rule,
                source:
                  source === 'file' || source === 'capture'
                    ? { kind: 'file', path: 'value.json' }
                    : { kind: 'watch', watchId: watch.id },
              },
            ],
          });
          let evidenceId: string;
          if (watch) {
            await s.engine.loop.poll(watch.id);
            evidenceId = s.store.get<any>('loop_watches', watch.id).lastEvidenceId;
            await s.engine.loop.poll(watch.id);
            assert.equal(s.store.all('loop_evidence').length, 1, 'unchanged parsed strings stay quiet');
          } else evidenceId = (await call('evidence.capture', { summary: '原始文件', path: 'value.json' })).id;
          const before = s.store.get<any>('loop_evidence', evidenceId);
          assert.deepEqual(before.data, source === 'capture' ? JSON.stringify(example.data) : example.data);
          const result = await call('decision.review', {
            id: d.id,
            revision: d.revision,
            outcome: 'inconclusive',
            conclusion: '只核对字段，不声称业务改善',
            evidenceIds: [evidenceId],
            nextDirection: '继续观察',
            assessment: {
              results: [
                { expectationId: 'value', verdict: example.verdict, reason: '按原类型', evidenceIds: [evidenceId] },
              ],
              conditions: 'matched',
              conditionReason: '同一隔离数据',
              diagnosis: 'pending',
              explanation: '没有部署收益证据',
              adjustment: 'observe',
            },
          });
          assert.equal(result.review.assessment.results[0].verdict, example.verdict);
          await call(
            'verification.request',
            { decisionId: d.id, evidenceIds: [evidenceId] },
            example.verdict === 'met' ? 200 : 409
          );
          const metrics = computeMetrics({ home: s.home, store: s.store });
          assert.notEqual(metrics.goalOutcome, 'unknown');
          if (metrics.goalOutcome !== 'unknown') assert.equal(metrics.goalOutcome.verdict, example.verdict);
          assert.deepEqual(s.store.get('loop_evidence', evidenceId), before, 'evaluation never rewrites sealed data');
        } finally {
          await receiver?.close();
          await s.cleanup();
        }
      });
  });
