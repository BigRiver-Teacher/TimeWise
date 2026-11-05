// 主题工具：读取 / 应用 / 保存 亮暗模式
export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'timewise-theme'

/** 读取用户上次的选择，没有则返回 null */
export function readStoredTheme(): ThemeMode | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'dark' || value === 'light' ? value : null
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用
    return null
  }
}

/** 当前应使用的主题：优先 localStorage，默认亮色 */
export function getPreferredTheme(): ThemeMode {
  return readStoredTheme() ?? 'light'
}

/** 切换 <html> 上的 dark class（Element Plus 与自定义变量都依赖它） */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark')
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 存不进去也不影响本次会话
  }
}
