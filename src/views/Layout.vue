<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import type { Component } from "vue";
import {
  Bell,
  EditPen,
  Finished,
  House,
  Odometer,
  Setting,
} from "@element-plus/icons-vue";
import logoUrl from "@/assets/logo.png";
import { useUserStore } from "@/stores/user";
const userStore = useUserStore();

/** 导航项：路径 / 文案 / Element Plus 图标组件 */
interface NavItem {
  path: string;
  label: string;
  icon: Component;
}

/** PC 端完整菜单（5 项） */
const pcMenu: NavItem[] = [
  { path: "/", label: "数据总览", icon: Odometer },
  { path: "/input", label: "智能录入", icon: EditPen },
  { path: "/reminder", label: "提醒中心", icon: Bell },
  { path: "/archive", label: "已完成归档", icon: Finished },
  { path: "/settings", label: "系统设置", icon: Setting },
];

/** 移动端精简菜单（4 项） */
const mobileMenu: NavItem[] = [
  { path: "/", label: "首页", icon: House },
  { path: "/input", label: "录入", icon: EditPen },
  { path: "/reminder", label: "提醒", icon: Bell },
  { path: "/settings", label: "设置", icon: Setting },
];

const route = useRoute();

/**
 * 详情页不在菜单里，但它是从总览进入的，
 * 所以把 /detail 归到「数据总览」这一项上，高亮才不会丢。
 */
function isActive(path: string): boolean {
  if (path === "/")
    return route.path === "/" || route.path.startsWith("/detail");
  return route.path === path;
}

const activeMenu = computed<string>(() => {
  if (route.path.startsWith("/detail")) return "/";
  return route.path;
});

/** 顶栏标题取自路由 meta.title */
const currentTitle = computed<string>(() => {
  const meta = route.meta as { title?: string };
  return meta.title ?? "知时 TimeWise";
});

const userName = computed(() => userStore.userName);
const userInitial = computed(() => userStore.userName.slice(0, 1));
</script>

<template>
  <div class="layout">
    <!-- 左侧：PC 侧边栏 -->
    <aside class="sidebar">
      <div class="logo">
        <img
          class="logo-img"
          :src="logoUrl"
          alt="知时 TimeWise"
          height="32"
          width="32"
        />
        <div class="logo-text">
          <strong class="logo-title">知时</strong>
          <span class="logo-sub">TimeWise</span>
        </div>
      </div>

      <el-menu
        class="side-menu"
        router
        :default-active="activeMenu"
        :ellipsis="false"
      >
        <el-menu-item
          v-for="item in pcMenu"
          :key="item.path"
          :index="item.path"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>

      <div class="side-footer">
        <span class="ai-dot"></span>
        AI 助手已就绪
      </div>
    </aside>

    <!-- 右侧：顶栏 + 内容 -->
    <div class="main">
      <header class="topbar">
        <div class="breadcrumb">
          <span class="crumb-brand">知时</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-current">{{ currentTitle }}</span>
        </div>

        <div class="user">
          <el-avatar
            :size="32"
            :src="userStore.avatarUrl"
            class="user-avatar-img"
          >
            <span v-if="!userStore.avatarUrl">{{ userInitial }}</span>
          </el-avatar>
          <span class="user-name">{{ userName }}</span>
        </div>
      </header>

      <main class="content">
        <RouterView v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <!-- 底部：移动端导航 -->
    <nav class="bottom-nav" aria-label="底部导航">
      <RouterLink
        v-for="item in mobileMenu"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ 'is-active': isActive(item.path) }"
        :aria-current="isActive(item.path) ? 'page' : undefined"
      >
        <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style scoped lang="scss">
// 品牌色一律走全局令牌：亮色 --brand #4f46e5 / 暗色 #6366f1（批次1令牌化）
$brand-soft: var(--brand-soft);
$text: var(--app-text);
$text-muted: var(--app-text-muted);
$text-subtle: var(--app-text-subtle);
$bg: var(--app-bg);
$surface: var(--app-surface);
$line: var(--app-line);

.layout {
  display: flex;
  min-height: 100vh;
  background: transparent;
  color: $text;
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* ---------------- 侧边栏 ---------------- */
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  width: 220px;
  height: 100vh;
  flex-shrink: 0;
  border-right: 1px solid var(--glass-border);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 18px;
  flex-shrink: 0;
}

.logo-img {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
  object-fit: contain;
  /* 微微的悬浮感：与玻璃侧边栏呼应 */
  box-shadow: 0 2px 8px tint(brand, 28%);
  transition: transform 0.25s var(--ease);
}

.logo:hover .logo-img {
  transform: rotate(-6deg) scale(1.06);
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.logo-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: $text;
}

.logo-sub {
  margin-top: 1px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: $text-subtle;
}

.side-menu {
  flex: 1;
  padding: 6px 0;
  border-right: none;
  background: transparent;
  overflow-y: auto;

  :deep(.el-menu-item) {
    position: relative;
    height: 44px;
    margin: 4px 12px;
    padding: 0 12px !important;
    border-radius: 10px;
    color: var(--app-text-muted);
    font-size: 13.5px;
    font-weight: 500;
    transition:
      background 0.18s ease,
      color 0.18s ease,
      transform 0.18s var(--ease);

    &:hover {
      background: var(--chip-bg);
      color: $text;
      transform: translateX(2px);
    }

    &.is-active {
      background: $brand-soft;
      color: var(--brand);
      font-weight: 600;

      &::before {
        content: "";
        position: absolute;
        left: -12px;
        top: 50%;
        width: 3px;
        height: 20px;
        transform: translateY(-50%) scaleY(0.4);
        border-radius: 0 3px 3px 0;
        background: var(--brand);
        opacity: 0;
        transition:
          transform 0.24s var(--ease),
          opacity 0.24s ease;
      }

      &::before {
        transform: translateY(-50%) scaleY(1);
        opacity: 1;
      }

      .el-icon {
        color: var(--brand);
      }
    }
  }

  :deep(.el-icon) {
    margin-right: 10px;
    font-size: 17px;
    color: $text-subtle;
  }
}

.side-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px;
  padding: 10px 12px;
  flex-shrink: 0;
  border: 1px solid tint(success, 28%);
  border-radius: 12px;
  background: var(--success-soft);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--success-text);
  font-size: 11.5px;
  font-weight: 500;
}

.ai-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px tint(success, 16%);
  animation: ai-dot-breathe 2.4s ease-in-out infinite;
}

@keyframes ai-dot-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 3px tint(success, 16%);
  }

  50% {
    box-shadow: 0 0 0 5px tint(success, 7%);
  }
}

/* ---------------- 顶栏 ---------------- */
.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 60px;
  padding: 0 28px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  min-width: 0;
}

.crumb-brand {
  color: $text-subtle;
}

.crumb-sep {
  color: var(--app-line);
}

.crumb-current {
  overflow: hidden;
  color: $text;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.user-avatar-img {
  flex-shrink: 0;
  background: $brand-soft;
  color: var(--brand);
  font-size: 12.5px;
  font-weight: 700;
  box-shadow:
    0 0 0 2px var(--glass-bg-strong),
    0 2px 8px tint(brand, 22%);
  transition: transform 0.25s var(--ease);

  &:hover {
    transform: scale(1.08);
  }
}

.user-name {
  font-size: 13px;
  color: var(--app-text-muted);
}

/* ---------------- 内容区 ---------------- */
.content {
  flex: 1;
  padding: 24px 28px 40px;
}

/* ---------------- 移动端底栏 ---------------- */
.bottom-nav {
  display: none;
}

/* ---------------- 响应式：768px 切换（统一走 _mixins 的 mobile 断点） ---------------- */
@include mobile {
  .sidebar {
    display: none;
  }

  .topbar {
    height: 54px;
    padding: 0 16px;
  }

  .user-name {
    display: none;
  }

  .content {
    /* 84px 让最后一条内容不被底栏遮挡，safe-area 让刘海屏/手势条同样留白 */
    padding: 16px 16px calc(84px + env(safe-area-inset-bottom));
  }

  .bottom-nav {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 100;
    display: flex;
    align-items: stretch;
    height: 60px;
    padding-bottom: env(safe-area-inset-bottom);
    border-top: 1px solid var(--glass-border);
    background: var(--glass-bg-strong);
    box-shadow: 0 -6px 18px rgba(16, 24, 40, 0.08);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
  }

  .nav-item {
    position: relative;
    z-index: 0;
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: $text-subtle;
    font-size: 11px;
    font-weight: 500;
    transition: color 0.18s ease;

    /* 激活态背后的药丸底色，比纯变色更有存在感 */
    &::before {
      content: "";
      position: absolute;
      z-index: -1;
      top: 6px;
      bottom: 6px;
      left: 50%;
      width: 58px;
      border-radius: 999px;
      background: $brand-soft;
      opacity: 0;
      transform: translateX(-50%) scale(0.7);
      transition:
        opacity 0.22s ease,
        transform 0.22s var(--ease);
    }

    &:focus-visible {
      outline: 2px solid tint(brand, 45%);
      outline-offset: -2px;
    }

    &.is-active {
      color: var(--brand);
      font-weight: 600;

      &::before {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }

      .nav-icon {
        transform: translateY(-1px);
      }
    }
  }

  .nav-icon {
    font-size: 19px;
    transition: transform 0.18s ease;
  }
}
</style>
<style lang="scss">
/* 
 * 路由切换动画：由于类名打在子页面根节点，此处不能使用 scoped
 */
.page-fade-enter-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.page-fade-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 新页从右侧滑入并轻微上浮，旧页向左淡出：方向感更明确 */
.page-fade-enter-from {
  opacity: 0;
  transform: translateX(20px) translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
  transform: translateX(-16px);
}

@media (prefers-reduced-motion: reduce) {
  .page-fade-enter-active,
  .page-fade-leave-active {
    transition: opacity 0.2s ease;
  }

  .page-fade-enter-from,
  .page-fade-leave-to {
    transform: none;
  }
}
</style>
