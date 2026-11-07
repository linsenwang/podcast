# 订阅打包服务：把 40+ 个 RSS 解析成一份精简 JSON，只跑 app.py 一个文件。
#
# 纯标准库（ElementTree / gzip / http.server），没有 pip 依赖，构建不会卡源。
# 和 podcast/thumbs 一样建 uid 1000 的用户，缓存目录 bind mount 进容器后
# 宿主机上直接能看/删。
FROM python:3-alpine

RUN adduser -D -H -u 1000 -s /sbin/nologin hostuser

WORKDIR /app
COPY app.py /app/app.py

RUN mkdir -p /app/cache && chown hostuser:hostuser /app/cache
USER hostuser

# 用 host 网络（见 docker-compose.yml），EXPOSE 只是写清楚端口给看的人
EXPOSE 8102

# -u：不缓冲 stdout，docker logs 里能立刻看到刷新完成/失败
CMD ["python3", "-u", "/app/app.py"]
