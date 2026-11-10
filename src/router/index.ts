import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../views/Layout.vue'
import Overview from '../views/Overview.vue'

/** 给 meta 加上类型约束，Layout 顶栏取标题时不用 as any */
declare module 'vue-router' {
  interface RouteMeta {
    /** 顶栏与页面标题 */
    title: string
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // 所有业务页面都挂在 Layout 下，共用侧边栏 / 顶栏 / 移动底栏
      path: '/',
      component: Layout,
      children: [
        {
          path: '',
          name: 'overview',
          component: Overview,
          meta: { title: '数据总览' },
        },
        {
          path: 'input',
          name: 'input',
          component: () => import('../views/Input.vue'),
          meta: { title: '智能录入' },
        },
        {
          path: 'reminder',
          name: 'reminder',
          component: () => import('../views/Reminder.vue'),
          meta: { title: '提醒中心' },
        },
        {
          path: 'archive',
          name: 'archive',
          component: () => import('../views/Archive.vue'),
          meta: { title: '已完成归档' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/Settings.vue'),
          meta: { title: '系统设置' },
        },
        {
          // 不在菜单里，从总览卡片进入
          path: 'detail',
          name: 'detail',
          component: () => import('../views/Detail.vue'),
          meta: { title: '条目详情' },
        },
      ],
    },
    {
      // 未匹配的路径统一回到总览
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

/**
 * 详情页 id 只接受正整数：
 * 拦截 5.5 / 1e3 / abc / 01 / -1 这类非法直链，直接回总览，
 * 不给详情页机会用非法 id 去请求接口。
 */
const DETAIL_ID_PATTERN = /^[1-9]\d*$/

router.beforeEach((to) => {
  if (to.name !== 'detail') return true

  const raw = Array.isArray(to.query.id) ? to.query.id[0] : to.query.id
  if (typeof raw === 'string' && DETAIL_ID_PATTERN.test(raw)) return true

  return { path: '/' }
})

/**
 * 懒加载页面的 chunk 拉取失败时（重新构建后旧 chunk 失效、开发期模块编译错误等），
 * 浏览器会缓存这次失败的动态 import，之后点击菜单不会再发起请求，表现为「点了没反应」。
 * 这里做一次性自动刷新，让页面重新拿到最新的 chunk；用 sessionStorage 防止死循环。
 */
const CHUNK_RELOAD_KEY = 'timewise:chunk-reload'

router.onError((error) => {
  const message = String((error as Error)?.message ?? '')
  const isChunkError =
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)

  if (!isChunkError) return
  if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return

  sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
  window.location.reload()
})

/** 成功进入页面后清掉标记，保证下次出现 chunk 失效时还能自愈 */
router.afterEach(() => {
  sessionStorage.removeItem(CHUNK_RELOAD_KEY)
})

export default router
