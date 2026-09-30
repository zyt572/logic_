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

## 说明

- 本版本不包含 Node 后端，不需要 `npm install`。
- 题目来自 `data/questions.js` 内置题库。
- 登录、积分、错题、签到都保存在当前浏览器，换浏览器或清理缓存后会丢失。