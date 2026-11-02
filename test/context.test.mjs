import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectDegenerate, assessContext, DEFAULT_TOKEN_WARN, DEFAULT_TOKEN_CRITICAL } from '../src/detect/context.js'

test('识别中文退化模板（事故原文）', () => {
  assert.equal(detectDegenerate('作为一个人工智能语言模型，我还没学习如何回答这个问题').degenerate, true)
})
test('识别英文退化模板', () => {
  assert.equal(detectDegenerate('As an AI language model, I cannot help with that').degenerate, true)
})
test('正常回答不误判', () => {
  assert.equal(detectDegenerate('这段代码的作用是把数组去重').degenerate, false)
})
test('空输出不误判', () => {
  assert.equal(detectDegenerate('').degenerate, false)
})
test('水位 ok', () => {
  assert.equal(assessContext({ inputTokens: 50000, text: '正常' }).level, 'ok')
})
test('水位 warn（对齐事故的 285k）', () => {
  const r = assessContext({ inputTokens: 285000, text: '正常' })
  assert.equal(r.level, 'warn')
  assert.equal(r.shouldCompact, false, '仅 warn 且未退化 ⇒ 暂不压缩')
})
test('warn + 退化 ⇒ 应压缩（事故场景）', () => {
  const r = assessContext({ inputTokens: 285000, text: '作为一个人工智能语言模型' })
  assert.equal(r.shouldCompact, true)
})
test('critical 直接应压缩', () => {
  assert.equal(assessContext({ inputTokens: 330000, text: '正常' }).shouldCompact, true)
})
test('阈值可配', () => {
  assert.equal(assessContext({ inputTokens: 100, warnAt: 50 }).level, 'warn')
})
test('无 token 信息时不误判为健康', () => {
  assert.equal(assessContext({ text: '正常' }).level, 'unknown')
})
test('阈值常量对齐事故数据', () => {
  assert.equal(DEFAULT_TOKEN_WARN, 250000)
  assert.ok(DEFAULT_TOKEN_CRITICAL > DEFAULT_TOKEN_WARN)
})
