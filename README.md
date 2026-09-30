# 逻辑题每日刷

一个纯静态的逻辑题每日刷网页，可直接部署到 GitHub Pages。

## 功能

- 登录 / 注册（数据保存在浏览器 localStorage）
- 每日 3-5 道逻辑选择题
- 再来一道加题
- 错题库、重看、重做
- 每日签到
- 答题积分、段位提升
- 移动端适配、PWA 桌面图标

## 部署到 GitHub Pages

1. 新建 GitHub 仓库。
2. 把本目录下的所有文件上传到仓库根目录。
3. 打开仓库 Settings  Pages。
4. Build and deployment：
   - Source 选择 `Deploy from a branch`
   - Branch 选择 `main`，目录选择 `/ (root)`
5. 保存后等待 GitHub Pages 生成访问地址。

访问地址形如：

```text
https://你的用户名.github.io/仓库名/
```

## 本地预览

可以直接双击 `index.html` 打开，也可以使用任意静态服务器：

```bash
python -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

## 题库导入

在游戏里的我的  题库管理中，可以选择本地文件导入题库：

- 支持 `.json`
- 支持 `.txt`，会自动解析并转换成 JSON 题库
- TXT 推荐格式：

```text
1. 题目内容
答案：答案内容

2. 题目内容
答案：答案内容
```

导入后保存在浏览器 `localStorage` 中，可点击清空自定义导入清除。

## 说明

- 本版本不包含 Node 后端，不需要 `npm install`。
- 内置题目来自 `data/questions.js`。
- 预置 237 道逻辑题来自 `data/imported-questions.js`，会自动转换为选择题加入游戏。
- 登录、积分、错题、签到、自定义导入都保存在当前浏览器，换浏览器或清理缓存后会丢失。