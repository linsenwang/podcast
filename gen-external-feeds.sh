#!/bin/sh
# 按 /etc/nginx/external-feeds.tsv 生成 nginx 的 location 片段。
#
# 这个脚本挂进容器的 /docker-entrypoint.d/，nginx 官方入口会在启动 nginx 前
# 自动执行它，所以加外部订阅只需要改 external-feeds.tsv 再重启容器，
# 不用再手写 nginx.conf。生成的是 server 块内的片段，由 nginx.conf include。
set -eu

SRC=/etc/nginx/external-feeds.tsv
OUT=/etc/nginx/external-feeds.locations.conf

if [ ! -f "$SRC" ]; then
    echo "external-feeds: 找不到 $SRC，外部订阅反代将为空" >&2
    : > "$OUT"
    exit 0
fi

{
    echo "# 由 $SRC 自动生成，请勿手改。"
    # 三列：id <TAB> 显示名 <TAB> 上游 URL；显示名只给客户端，这里跳过。
    awk -F '\t' '
        { sub(/\r$/, "") }
        /^[[:space:]]*(#|$)/ { next }
        {
            id = $1; url = $3
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", id)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", url)
            if (id !~ /^[a-z0-9_-]+$/ || url !~ /^https?:\/\/[^[:space:]]+$/) {
                print "external-feeds: 跳过非法行: " $0 > "/dev/stderr"
                next
            }
            host = url
            sub(/^https?:\/\//, "", host)
            sub(/\/.*$/, "", host)
            printf "\n# %s\n", id
            printf "location = /ext/%s/rss {\n", id
            printf "    proxy_pass %s;\n", url
            printf "    proxy_http_version 1.1;\n"
            printf "    proxy_set_header Host %s;\n", host
            if (url ~ /^https:\/\//) printf "    proxy_ssl_server_name on;\n"
            printf "    add_header Cache-Control \"no-cache\" always;\n"
            printf "}\n"
        }
    ' "$SRC"
} > "$OUT"

n=$(grep -c '^location ' "$OUT" || true)
echo "external-feeds: 已生成 $OUT（${n:-0} 条）"
