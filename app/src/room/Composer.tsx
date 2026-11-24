import { createSignal } from 'solid-js'

export default function Composer(props: { onSend: (text: string) => void }) {
  let el: HTMLTextAreaElement | undefined
  const [composing, setComposing] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)

  const send = () => {
    const value = el?.value ?? ''
    if (!value.trim() || composing()) return
    props.onSend(value.trim())
    if (el) {
      el.value = ''
      el.style.height = 'auto'
    }
  }

  const autoGrow = () => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <footer
      class="composer"
      classList={{ dragging: dragging() }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
      }}
    >
      <span class="caret" aria-hidden="true" />
      <textarea
        ref={el}
        class="composer-input"
        rows={1}
        autofocus
        placeholder="Type. The room answers."
        aria-label="Message"
        onInput={autoGrow}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !composing()) {
            e.preventDefault()
            send()
          }
        }}
      />
      <span class="hint">Ctrl K</span>
    </footer>
  )
}
