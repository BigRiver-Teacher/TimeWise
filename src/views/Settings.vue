<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { applyTheme, getPreferredTheme, saveTheme } from "@/utils/theme";
import type { ThemeMode } from "@/utils/theme";
import { useUserStore } from "@/stores/user"; // 引入刚刚建好的 Store
import { useSettingsStore } from "@/stores/settings";
import type { AiModelMode, SummaryLength } from "@/stores/settings";
import type { UploadFile } from "element-plus";
import { ElMessage } from "element-plus";

interface SettingsState {
  /** 应用内提醒 */
  inApp: boolean;
  /** 邮件提醒 */
  email: boolean;
  /** 每周总结 */
  weeklyDigest: boolean;
}

interface ModelOption {
  value: AiModelMode;
  label: string;
  desc: string;
}

interface LengthOption {
  value: SummaryLength;
  label: string;
}

/**
 * 提醒类开关只在设置页用，先留在本地；
 * AI 解析偏好（模型档位 / 摘要长度）改由 Pinia 管理，Input.vue 解析时会读它。
 */
const settings = reactive<SettingsState>({
  inApp: true,
  email: false,
  weeklyDigest: true,
});

const settingsStore = useSettingsStore();

const modelOptions: ModelOption[] = [
  { value: "fast", label: "快速模式", desc: "本地轻量模型，约 3 秒返回结果" },
  { value: "quality", label: "精准模式", desc: "本地完整模型，约 8 秒，概括更完整" },
];

const lengthOptions: LengthOption[] = [
  { value: "short", label: "一句话" },
  { value: "medium", label: "三行以内" },
  { value: "long", label: "完整段落" },
];

/** 当前模型档位的说明文案 */
const modelDesc = computed<string>(
  () =>
    modelOptions.find((item) => item.value === settingsStore.aiModel)?.desc ?? "",
);

/* ---------------------------- 个人资料 ---------------------------- */
const userStore = useUserStore();
const inputName = ref("");

onMounted(() => {
  inputName.value = userStore.userName;
});

// 失去焦点时保存昵称
const saveName = () => {
  if (inputName.value.trim()) {
    userStore.updateName(inputName.value.trim());
    ElMessage.success("昵称已更新");
  } else {
    inputName.value = userStore.userName; // 如果为空，恢复原值
  }
};

// 处理头像上传
const handleAvatarChange = (file: UploadFile) => {
  const rawFile = file.raw;
  if (!rawFile) return;

  if (rawFile.size > 2 * 1024 * 1024) {
    ElMessage.error("头像图片不能超过 2MB");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const base64 = e.target?.result as string;
    userStore.updateAvatar(base64);
    ElMessage.success("头像已更新");
  };
  reader.readAsDataURL(rawFile);
};

/* ---------------------------- 外观（亮 / 暗） ---------------------------- */
const isDark = ref<boolean>(getPreferredTheme() === "dark");

function handleThemeChange(value: boolean): void {
  const mode: ThemeMode = value ? "dark" : "light";
  applyTheme(mode);
  saveTheme(mode);
}

onMounted(() => {
  applyTheme(isDark.value ? "dark" : "light");
});
</script>

<template>
  <div class="settings-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">系统设置</h1>
        <p class="page-subtitle">
          调整提醒渠道与 AI 解析偏好，修改后立即生效。
        </p>
      </div>
      <span class="auto-save">
        <span class="auto-dot"></span>
        已自动保存
      </span>
    </header>

    <!-- 个人资料（新增） -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-icon">
          <!-- 用户图标 -->
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">个人资料</h2>
          <p class="panel-sub">修改你的展示头像与昵称</p>
        </div>
      </div>

      <div class="setting-list">
        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">头像</h3>
            <p class="setting-desc">点击右侧头像上传新图片（限 2MB 内）</p>
          </div>
          <!-- 头像上传组件 -->
          <el-upload
            class="avatar-uploader"
            action="#"
            :show-file-list="false"
            :auto-upload="false"
            :on-change="handleAvatarChange"
          >
            <el-avatar
              :size="50"
              :src="
                userStore.avatarUrl ||
                'https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png'
              "
              class="avatar-hover"
            >
              {{ !userStore.avatarUrl ? userStore.userName.charAt(0) : "" }}
            </el-avatar>
          </el-upload>
        </div>

        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">昵称</h3>
            <p class="setting-desc">输入框失去焦点时自动保存</p>
          </div>
          <el-input
            v-model="inputName"
            placeholder="请输入昵称"
            class="setting-control"
            @blur="saveName"
          />
        </div>
      </div>
    </section>

    <!-- 外观设置 -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-icon">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">外观设置</h2>
          <p class="panel-sub">切换后立即生效，并会记住你的选择</p>
        </div>
      </div>

      <div class="setting-list">
        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">深色模式</h3>
            <p class="setting-desc">夜间使用更护眼，卡片会切换为深灰玻璃质感</p>
          </div>
          <el-switch v-model="isDark" @change="handleThemeChange" />
        </div>
      </div>
    </section>

    <!-- 提醒偏好 -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-icon">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.2.8 4.6 1.5 5.5H5c.7-.9 1.5-2.3 1.5-5.5Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
            <path
              d="M10 18.5a2 2 0 0 0 4 0"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">提醒偏好</h2>
          <p class="panel-sub">决定提醒从哪些渠道触达你</p>
        </div>
      </div>

      <div class="setting-list">
        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">应用内提醒</h3>
            <p class="setting-desc">解析完成后在页面内弹出提示</p>
          </div>
          <el-switch v-model="settings.inApp" />
        </div>

        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">邮件提醒</h3>
            <p class="setting-desc">按智能提醒时间点发送邮件</p>
          </div>
          <el-switch v-model="settings.email" />
        </div>

        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">每周总结</h3>
            <p class="setting-desc">每周一上午推送上周完成情况</p>
          </div>
          <el-switch v-model="settings.weeklyDigest" />
        </div>
      </div>
    </section>

    <!-- AI 解析 -->
    <section class="panel">
      <div class="panel-head">
        <span class="panel-icon is-ai">
          <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.3 10.1 12.8 4.5 10.9 10.1 9Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              d="M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9Z"
              fill="currentColor"
              opacity=".55"
            />
          </svg>
        </span>
        <div class="panel-title-group">
          <h2 class="panel-title">AI 解析</h2>
          <p class="panel-sub">影响录入时的解析速度与概括详细程度</p>
        </div>
      </div>

      <div class="setting-list">
        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">解析模型</h3>
            <p class="setting-desc">{{ modelDesc }}</p>
          </div>
          <el-select v-model="settingsStore.aiModel" class="setting-control">
            <el-option
              v-for="option in modelOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </div>

        <div class="setting-row">
          <div class="setting-text">
            <h3 class="setting-title">摘要长度</h3>
            <p class="setting-desc">AI 概括一句话摘要时保留的信息量</p>
          </div>
          <el-select v-model="settingsStore.summaryLength" class="setting-control">
            <el-option
              v-for="option in lengthOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.settings-page {
  --el-text-color-regular: var(--app-text);
  --el-border-radius-base: var(--radius-sm);

  max-width: var(--content-max);
  margin: 0 auto;
  color: var(--app-text);
  font-size: var(--fs-base);
}

.icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.page-head {
  @include page-head;
}

.page-title {
  @include page-title;
}

.page-subtitle {
  @include page-subtitle;
}

.auto-save {
  @include status-pill(success);
}

.auto-dot {
  @include status-dot(success);
}

/* ---------------- 面板 ---------------- */
.panel {
  @include glass-panel(24px 24px 8px);

  & + & {
    margin-top: 16px;
  }
}

.panel-head {
  @include panel-head;

  margin-bottom: 8px;
}

.panel-icon {
  @include panel-icon(brand);

  .icon {
    width: 18px;
    height: 18px;
  }

  &.is-ai {
    @include panel-icon(ai);
  }
}

.panel-title-group {
  min-width: 0;
}

.panel-title {
  @include panel-title;
}

.panel-sub {
  @include panel-sub;
}

/* ---------------- 设置行 ---------------- */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 0;
  border-top: 1px solid var(--app-line-soft);
}

.setting-text {
  min-width: 0;
}

.setting-title {
  color: var(--app-text);
  font-size: var(--fs-base);
  font-weight: 600;
}

.setting-desc {
  margin-top: 4px;
  color: var(--app-text-subtle);
  font-size: var(--fs-xs);
}

.setting-control {
  width: 160px;
  flex-shrink: 0;
}

/* ---------------- 头像上传 ---------------- */
.avatar-uploader {
  flex-shrink: 0;
  cursor: pointer;

  :deep(.el-upload) {
    border-radius: 50%;
  }

  :deep(.el-upload:focus-visible) {
    outline: 2px solid var(--brand-ring);
    outline-offset: 3px;
  }
}

.avatar-hover {
  border: 2px solid transparent;
  @include transition(border-color, transform, box-shadow);
}

.avatar-uploader:hover .avatar-hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-brand);
  transform: scale(1.05);
}

@include mobile {
  .panel {
    padding: 16px 16px 4px;
  }

  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .setting-control {
    width: 100%;
  }
}
</style>
