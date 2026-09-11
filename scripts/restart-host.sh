#!/bin/sh
# dsh 宿主重启（一次性）：脱离宿主进程组执行，宿主被 kill 后仍继续。
# 用法：restart-host.sh [等待秒数]（默认 4：留出把回复送达前端的时间）
# 复刻原启动参数与工作目录；重启后自检端口与 taskflow 端点。
# 注意：宿主有认证网关，脚本里的 curl 是未认证请求——「非 404」即证明路由已挂载，
# 只有 404 才代表路由缺失（需要用浏览器登录后的会话做端到端验收）。
LOG=/tmp/dsh-restart.log
WAIT="${1:-4}"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') 重启开始 ==="

OLD_PIDS=$(pgrep -f 'dsh --profile web' | tr '\n' ' ')
if [ -z "$OLD_PIDS" ]; then
  echo "未找到运行中的 dsh web 进程，直接拉起"
else
  echo "旧进程：$OLD_PIDS"
  sleep "$WAIT"
  pkill -f 'dsh --profile web'
  i=0
  while pgrep -f 'dsh --profile web' >/dev/null 2>&1 && [ "$i" -lt 40 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  if pgrep -f 'dsh --profile web' >/dev/null 2>&1; then
    echo "优雅退出超时，SIGKILL"
    pkill -9 -f 'dsh --profile web'
    sleep 1
  fi
  echo "旧进程已退出（等待 $((i / 2))s）"
fi

# 端口释放确认
i=0
while [ "$i" -lt 20 ]; do
  if ! (ss -ltn 2>/dev/null | grep -q ':28080 '); then break; fi
  sleep 0.5
  i=$((i + 1))
done

cd /root || exit 1
setsid nohup node /root/.npm-global/bin/dsh --profile web --port 28080 --trusted-host 110.40.172.102 >>/root/.dsh/web-host.log 2>&1 &
sleep 1
NEW_PID=$(pgrep -f 'dsh --profile web' | head -1)
echo "新进程已拉起：PID ${NEW_PID:-未知}"
echo "${NEW_PID:-}" >/tmp/dsh-host.pid

# 等端口就绪
i=0
while [ "$i" -lt 60 ]; do
  if ss -ltn 2>/dev/null | grep -q ':28080 '; then break; fi
  sleep 0.5
  i=$((i + 1))
done
sleep 1

echo "--- 自检 GET /api/taskflow/models（未认证访问：非 404 = 路由已挂载）:"
curl -s -m 8 -o /tmp/dsh-selfcheck-models.txt -w 'HTTP %{http_code}\n' \
  -H 'host: 127.0.0.1:28080' http://127.0.0.1:28080/api/taskflow/models
head -c 200 /tmp/dsh-selfcheck-models.txt 2>/dev/null
echo
echo "--- 自检 GET /api/taskflow/settings:"
curl -s -m 5 -o /tmp/dsh-selfcheck-settings.txt -w 'HTTP %{http_code}\n' \
  -H 'host: 127.0.0.1:28080' http://127.0.0.1:28080/api/taskflow/settings
head -c 200 /tmp/dsh-selfcheck-settings.txt 2>/dev/null
echo
echo "--- 自检 GET /api/taskflow/state:"
curl -s -m 5 -o /dev/null -w 'HTTP %{http_code}\n' -H 'host: 127.0.0.1:28080' http://127.0.0.1:28080/api/taskflow/state
echo "=== $(date '+%F %T') 重启收尾完成 ==="
