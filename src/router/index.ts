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

export default router
