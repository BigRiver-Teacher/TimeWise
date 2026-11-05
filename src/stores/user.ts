// src/store/user.ts
import { defineStore } from "pinia";
import { ref } from "vue";

export const useUserStore = defineStore("user", () => {
  // 从 localStorage 读取初始值，如果没有，默认叫"何同学"
  const userName = ref(localStorage.getItem("userName") || "何同学");
  const avatarUrl = ref(localStorage.getItem("avatarUrl") || "");

  // 修改名字的方法
  const updateName = (newName: string) => {
    userName.value = newName;
    localStorage.setItem("userName", newName);
  };

  // 修改头像的方法
  const updateAvatar = (newUrl: string) => {
    avatarUrl.value = newUrl;
    localStorage.setItem("avatarUrl", newUrl);
  };

  return { userName, avatarUrl, updateName, updateAvatar };
});
