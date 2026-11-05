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
        <RouterView />
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
      >
        <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style scoped lang="scss">
.layout {
  display: flex;
  min-height: 100vh;
  background: transparent;
  color: var(--app-text);
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
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.logo-title {
  font-size: var(--fs-md);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--app-text);
}

.logo-sub {
  margin-top: 1px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--app-text-subtle);
}

.side-menu {
  flex: 1;
  padding: 8px 0;
  border-right: none;
  background: transparent;
  overflow-y: auto;

  :deep(.el-menu-item) {
    position: relative;
    height: 44px;
    margin: 4px 12px;
    padding: 0 12px !important;
    border-radius: var(--radius-md);
    color: var(--app-text-muted);
    font-size: var(--fs-sm);
    font-weight: 500;
    @include transition(background, color);

    &:hover {
      background: var(--chip-bg);
      color: var(--app-text);
    }

    &.is-active {
      background: var(--brand-soft);
      color: var(--brand);
      font-weight: 600;

      &::before {
        content: "";
        position: absolute;
        left: -12px;
        top: 50%;
        width: 3px;
        height: 20px;
        transform: translateY(-50%);
        border-radius: 0 3px 3px 0;
        background: var(--brand);
      }

      .el-icon {
        color: var(--brand);
      }
    }
  }

  :deep(.el-icon) {
    margin-right: 10px;
    font-size: 18px;
    color: var(--app-text-subtle);
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
  border-radius: var(--radius-md);
  background: var(--success-soft);
  color: var(--success-text);
  font-size: var(--fs-xs);
  font-weight: 500;
}

.ai-dot {
  @include status-dot(success);
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
  font-size: var(--fs-sm);
  min-width: 0;
}

.crumb-brand {
  color: var(--app-text-subtle);
}

.crumb-sep {
  color: var(--app-text-subtle);
  opacity: 0.6;
}

.crumb-current {
  overflow: hidden;
  color: var(--app-text);
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
  background: var(--brand-soft);
  color: var(--brand);
  font-size: var(--fs-xs);
  font-weight: 700;
  box-shadow: 0 0 0 2px var(--glass-border);
}

.user-name {
  font-size: var(--fs-sm);
  color: var(--app-text-muted);
}

/* ---------------- 内容区 ---------------- */
.content {
  flex: 1;
  width: 100%;
  max-width: calc(var(--content-max) + 56px);
  margin: 0 auto;
  padding: 24px 28px 40px;
}

/* ---------------- 移动端底栏 ---------------- */
.bottom-nav {
  display: none;
}

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
    height: calc(60px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    border-top: 1px solid var(--glass-border);
    background: var(--glass-bg-strong);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
  }

  .nav-item {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--app-text-subtle);
    font-size: var(--fs-xs);
    font-weight: 500;
    @include transition(color);

    &:focus-visible {
      outline-offset: -2px;
    }

    &.is-active {
      color: var(--brand);
      font-weight: 600;

      .nav-icon {
        transform: translateY(-1px);
      }
    }
  }

  .nav-icon {
    font-size: 20px;
    @include transition(transform);
  }
}
</style>
