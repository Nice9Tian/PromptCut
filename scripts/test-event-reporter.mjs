// Node 的 spec 报告器不显示文件子进程的 exitCode；此报告器只给包装脚本留结构化事件。
export default async function* testEventReporter(events) {
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail' || event.type === 'test:stderr') {
      yield `${JSON.stringify(event)}\n`;
    }
  }
}
