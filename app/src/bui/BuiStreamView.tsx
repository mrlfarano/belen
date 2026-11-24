import { Show } from 'solid-js'
import BuiRenderer from './Renderer'
import { parseBuiPartial } from './partial'
import type { BuiPayload } from './schema'

export default function BuiStreamView(props: {
  text: string
  pinned?: boolean
  onTogglePin?: () => void
}) {
  const partial = () => parseBuiPartial(props.text)
  const payload = (): BuiPayload => ({ v: 1, blocks: partial().blocks })

  return (
    <>
      <Show when={partial().blocks.length > 0}>
        <BuiRenderer
          payload={payload()}
          pinned={props.pinned}
          onTogglePin={props.onTogglePin}
        />
      </Show>

      <Show when={!partial().complete}>
        <div class="bui-skeleton" aria-hidden="true">
          <span class="skeleton-line w70" />
          <span class="skeleton-line w45" />
          <span class="skeleton-line w60" />
          <span class="skeleton-label">composing</span>
        </div>
      </Show>
    </>
  )
}
