/**
 * cs-guard — 浏览器半身（骨架 v0.1.0）
 *
 * 约束：客户端半身必须单文件；设置分节用自有 id `cs-guard`。
 *
 * @module cs-guard/client
 */

const NAME = 'cs-guard'

export const name = `${NAME}-client`
export const version = '0.1.0'

export function apply(ctx) {
  ctx.slots?.inject?.('settings.section', () => ({
    id: `${NAME}-section`,
    name: `${NAME}-section`,
    label: 'cs-guard',
    order: 210,
    render: () => null,
  }))
}
