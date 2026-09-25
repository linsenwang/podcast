# 只为了两件事，别的不改：
#   1. 建一个 uid/gid 与宿主机用户一致的用户，供 nginx.conf / nginx-main.conf 里的
#      `user hostuser` 使用。nginx 的 user 指令走 getpwnam()，只认用户名，写数字 uid
#      会直接 `getpwnam("1000") failed` 起不来。
#   2. 同步目录是 bind mount（见 docker-compose.yml），属主是宿主机用户，
#      worker 降权到同一个 uid 才写得进去，不用 chown/chmod 宿主机目录。
# 1000 要和 `id -u` / `id -g` 对得上。
FROM nginx:alpine
RUN adduser -D -H -u 1000 -s /sbin/nologin hostuser
