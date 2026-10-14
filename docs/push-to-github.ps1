# 推送命令（复制粘贴到终端执行）
# 把 YOURNAME 换成你的 GitHub 用户名

cd C:\Users\AA\Documents\deepseek-harness\default-workspace\fairy-mobile

git remote add origin https://github.com/YOURNAME/fairy-mobile.git

git push -u origin main

# 若提示 remote 已存在，改用：
#   git remote set-url origin https://github.com/YOURNAME/fairy-mobile.git

# 若推送被拒绝（远程非空），先拉取：
#   git pull --rebase origin main
#   git push -u origin main
