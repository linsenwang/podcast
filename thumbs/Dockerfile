# 封面缩略图服务：python:3-alpine + Pillow，只跑 app.py 这一个文件。
#
# 为什么要建一个 uid 1000 的用户（与 podcast/Dockerfile 同一套路）：
#   缓存目录是 bind mount（见 docker-compose.yml），属主是宿主机用户，
#   进程降权到同一个 uid 才写得进去，宿主机上也方便直接看/删缓存文件。
#   1000 要和宿主机的 `id -u` / `id -g` 对得上。
#
# 基础镜像 python:3-alpine 缺失时（docker.io 直连不通）从 daocloud 镜像源补：
#   docker pull docker.m.daocloud.io/library/python:3-alpine
#   docker tag docker.m.daocloud.io/library/python:3-alpine python:3-alpine
FROM python:3-alpine

# 只有 Pillow 一个第三方依赖。默认源在国内经常超时，固定走清华源；
# 真要连不上再带上代理构建：
#   docker compose build --build-arg HTTPS_PROXY=http://192.168.1.116:7890 podcast-thumbs
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple Pillow

RUN adduser -D -H -u 1000 -s /sbin/nologin hostuser

WORKDIR /app
COPY app.py /app/app.py

# 镜像里先把缓存目录建好归 hostuser：首次挂到宿主机空目录时不用处理权限。
RUN mkdir -p /app/cache && chown hostuser:hostuser /app/cache
USER hostuser

# 用 host 网络（见 docker-compose.yml），EXPOSE 只是写清楚端口给看的人
EXPOSE 8101

# -u：不缓冲 stdout，docker logs 里能立刻看到 HIT/MISS 和上游失败
CMD ["python3", "-u", "/app/app.py"]
