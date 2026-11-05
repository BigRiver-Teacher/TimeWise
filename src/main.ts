import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// Element Plus 暗黑模式 CSS 变量（配合 html.dark 生效）
import 'element-plus/theme-chalk/dark/css-vars.css'
// 放在 EP 之后，让全局设计令牌覆盖 EP 默认主色
import './assets/main.css'

import App from './App.vue'
import router from './router'
import { applyTheme, getPreferredTheme } from './utils/theme'

// 首屏前应用主题，避免刷新时先亮后暗的闪烁
applyTheme(getPreferredTheme())

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(ElementPlus)

app.mount('#app')
