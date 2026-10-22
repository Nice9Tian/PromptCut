/**
 * 聊天页:侧栏里点一条 Agent 对话就进这里(用户 2026-10-23 定)。
 *
 * 形状照手机 App 里那种对话:上面一条标题栏(回去、对话名、它挂在哪个项目或分组上、共有还是私有),
 * 中间是消息,下面是贴底的输入框。自己说的话靠右、带底色的气泡;Agent 说的话靠左、不套气泡,
 * 只在前面放一个星芒头像 —— 和编辑器右栏那套一致(`src/editor/right/chat/MessageList.tsx` 的做法:
 * 「用户消息靠右、不放头像」),这样两边看着是同一个产品。
 *
 * Agent 那一轮做过的事单独列一小块(编辑器里那一栏叫「Agent 操作」,这里沿用同一个说法)。
 *
 * **这一版只跑界面**:消息是 `mockChat.ts` 里写死的,发出去只把自己那条贴上去,再回一条说明「不会真的
 * 回复」,不碰云端 Agent 服务、不改任何项目。要接什么写在 `mockChat.ts` 的文件头。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ChatSidePanel } from "./ChatSidePanel";
import { DetailEdit } from "./DetailEdit";
import type { MockMessage } from "./mockChat";
import type { MockAgentChat } from "./mockProjects";

/** 和 `.ps-chat-input` 的 max-height 对齐 */
const MAX_H = 200;

export function ChatView(props: {
  chat: MockAgentChat;
  /** 这条对话挂在哪儿,显示在标题下面 */
  whereText: string;
  /** 这条对话的消息。存在上层按对话号分开放,所以切走再回来还在 */
  messages: MockMessage[];
  onSend: (text: string) => void;
  onBack: () => void;
}): JSX.Element {
  const messages = props.messages;
  const [text, setText] = useState("");
  /** 右边那条拓展栏开着没有(标题栏右上角那颗按钮) */
  const [panel, setPanel] = useState(false);
  /** 拓展栏里点出来的那句说明,显示在输入框下面 */
  const [note, setNote] = useState("");
  /** 「详细编辑」展开了没有:展开时占满聊天区,输入框照旧留在下面 */
  const [detail, setDetail] = useState(false);
  /** 共有 / 私有(`product/agent.md`:新建默认共有,用户可以主动改为私有)。这一版只是界面上的开关 */
  const [shared, setShared] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);

  // 换一条对话:没发出去的草稿不带过去
  useEffect(() => {
    setText("");
  }, [props.chat.id]);

  // 新消息进来滚到底
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    props.onSend(t);
    setText("");
    requestAnimationFrame(fit);
  };

  const seed = props.chat.on === "project" ? props.chat.projectId : props.chat.groupId;

  return (
    <main className="ps-main ps-chat" data-pc="start-chat" data-chat={props.chat.id}>
      {/* 标题栏横向填满整页(用户 2026-10-23 定):拓展栏只从下面那一行里让出宽度,不切标题栏 */}
      <header className="ps-chat-head">
        <button type="button" className="ps-chat-back" data-pc="start-chat-back" aria-label="回到开始页" onClick={props.onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="ps-chat-title">
          <span className="ps-chat-name" data-pc="start-chat-name">{props.chat.name}</span>
          <span className="ps-chat-where">{props.whereText}</span>
        </div>
        {/* 共有 / 私有:产品里是真开关(product/agent.md),这一版只切界面 */}
        <button
          type="button"
          className="ps-chat-vis"
          data-pc="start-chat-visibility"
          aria-pressed={!shared}
          title="待办：共有 / 私有要由云端文档服务记录并核对权限"
          onClick={() => setShared((v) => !v)}
        >
          {shared ? "共有" : "私有"}
        </button>
        {/* 右边那条拓展栏的开关:看画面、看这次改动、切改前改后 */}
        <button
          type="button"
          className="ps-chat-ext-btn"
          data-pc="start-chat-ext-toggle"
          aria-pressed={panel}
          aria-label="右侧拓展栏"
          title="画面、修改前 / 修改后"
          onClick={() => setPanel((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2" />
            <path d="M15 4.5v15" />
          </svg>
        </button>
      </header>

      {/*
        「详细编辑」展开时整块换成编辑视图,占满聊天区;输入框不在这一行里(它在下面的 ps-chat-foot),
        所以照旧留着 —— 用户就能在编辑视图里右键一张卡、把它引用进输入框。
      */}
      {detail ? (
        <div className="ps-chat-row is-detail">
          <DetailEdit
            seed={seed}
            onClose={() => setDetail(false)}
            onQuote={(q) => {
              setText((t) => (t.trim() ? `${t.trimEnd()} ${q} ` : `${q} `));
              area.current?.focus();
              setNote(`已把「${q}」放进输入框。`);
            }}
          />
        </div>
      ) : (
      <div className="ps-chat-row">
        <div className="ps-chat-col">
      <div className="ps-chat-scroll">
        <div className="ps-chat-list">
          {messages.map((m) =>
            m.from === "me" ? (
              <div key={m.id} className="ps-msg is-me" data-pc="start-chat-msg" data-from="me">
                <div className="ps-bubble">{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className="ps-msg is-agent" data-pc="start-chat-msg" data-from="agent">
                <span className="ps-msg-avatar" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
                  </svg>
                </span>
                <div className="ps-msg-body">
                  <p className="ps-msg-text">{m.text}</p>
                  {m.actions && m.actions.length > 0 && (
                    <div className="ps-actions">
                      <div className="ps-actions-head">Agent 操作</div>
                      <ul className="ps-actions-list">
                        {m.actions.map((a) => <li key={a}>{a}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          <div ref={tail} />
        </div>
      </div>
        </div>

        {panel && <ChatSidePanel chatId={props.chat.id} projectSeed={seed} onNote={setNote} onDetail={() => setDetail(true)} />}
      </div>
      )}

      {/* 输入框在这一行之外:所以「详细编辑」展开、消息被挡住时,它照旧在下面 */}
      <div className="ps-chat-foot">
        <div className="ps-chat-box">
          <textarea
            ref={area}
            className="ps-chat-input"
            data-pc="start-chat-input"
            value={text}
            placeholder={`对「${props.chat.name}」说点什么`}
            aria-label="写一条消息"
            onChange={(e) => {
              setText(e.target.value);
              fit();
            }}
            onKeyDown={(e) => {
              // 回车发送、Shift+回车换行;输入法组合中的回车不算(中文输入按回车是在选字)
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="ps-prompt-send"
            data-pc="start-chat-send"
            disabled={!text.trim()}
            aria-label="发送"
            onClick={send}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        <p className="ps-chat-note" role="status" data-pc="start-chat-note">
          {note || "界面预览阶段：发出去不会真的跑 Agent，也不会改动项目。"}
        </p>
      </div>
    </main>
  );
}
