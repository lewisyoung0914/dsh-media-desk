// 小红书：把 xiaohongshu-mcp 的发现、互动和发布能力接进工作台。
// Host 半片（src/xhs.js）负责跟 MCP 服务说话，这里只管界面：连接、搜索、看详情、发布、存灵感。
import React from 'react'
import { dispatchOps, report, setDesk, toast, useDesk, xhsRequest } from './desk.js'
import { Dialog, Empty, Icon, Segmented } from './ui.jsx'
import { t, useLang } from './i18n.js'

const SECTIONS = [
  { id: 'discover', label: '发现', icon: 'search' },
  { id: 'publish', label: '发布', icon: 'send' },
  { id: 'account', label: '账号', icon: 'user' },
]

// 稳定的空数组：选择器每次返回新对象会让 useSyncExternalStore 无限重渲染
const EMPTY_ITEMS = []

const VISIBILITY = ['公开可见', '仅自己可见', '仅互关好友可见']
const SORTS = ['综合', '最新', '最多点赞', '最多评论', '最多收藏']
const TYPES = ['不限', '视频', '图文']
const TIMES = ['不限', '一天内', '一周内', '半年内']

/** 取对象上第一个存在的键，MCP 返回的字段有驼峰也有下划线。 */
function first(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key]
  }
  return undefined
}

function asList(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return [value]
  return []
}

/** 从任意形状的返回里挑出笔记：不猜具体结构，只找“有 id、又有标题或封面”的对象。 */
export function collectNotes(data) {
  const notes = []
  const seen = new Set()
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8) return
    if (Array.isArray(value)) {
      value.forEach(row => walk(row, depth + 1))
      return
    }
    const card = first(value, ['noteCard', 'note_card', 'noteInfo', 'note_info', 'note']) ?? value
    // 搜索接口的 id/xsec_token 挂在外层，笔记卡片里只有标题和封面，两边都要看
    const pick = (keys) => first(card, keys) ?? first(value, keys)
    const id = pick(['id', 'noteId', 'note_id', 'feedId', 'feed_id'])
    const title = pick(['displayTitle', 'display_title', 'title', 'desc'])
    const cover = pick(['cover', 'image'])
    const coverUrl = typeof cover === 'string' ? cover : first(cover, ['urlDefault', 'url_default', 'urlPre', 'url_pre', 'url'])
    if (id && (title || coverUrl)) {
      const key = String(id)
      if (!seen.has(key)) {
        seen.add(key)
        const token = first(value, ['xsecToken', 'xsec_token']) ?? first(card, ['xsecToken', 'xsec_token']) ?? ''
        const user = first(card, ['user', 'author']) ?? {}
        const interact = first(card, ['interactInfo', 'interact_info', 'interactions']) ?? {}
        const type = first(card, ['type']) ?? ''
        const tags = asList(first(card, ['tagList', 'tag_list', 'tags'])).map(tag => (typeof tag === 'string' ? tag : first(tag, ['name', 'title']))).filter(Boolean)
        notes.push({
          id: key,
          token: String(token ?? ''),
          title: typeof title === 'string' ? title : '',
          desc: String(first(card, ['desc', 'content', 'body']) ?? ''),
          cover: typeof coverUrl === 'string' ? coverUrl : '',
          author: String(first(user, ['nickname', 'nickName', 'nick_name', 'name']) ?? ''),
          liked: String(first(interact, ['likedCount', 'liked_count', 'liked']) ?? ''),
          collected: String(first(interact, ['collectedCount', 'collected_count']) ?? ''),
          comments: String(first(interact, ['commentCount', 'comment_count']) ?? ''),
          video: String(type).toLowerCase().includes('video'),
          tags: tags.slice(0, 8),
          raw: card,
        })
      }
      return
    }
    Object.values(value).forEach(row => walk(row, depth + 1))
  }
  walk(data, 0)
  return notes
}

/** 笔记在小红书上的地址，带上 xsec_token 才能打开。 */
function noteUrl(note) {
  if (!note?.id) return ''
  const base = `https://www.xiaohongshu.com/explore/${note.id}`
  return note.token ? `${base}?xsec_token=${encodeURIComponent(note.token)}&xsec_source=pc_search` : base
}

function findImages(data) {
  const found = []
  const seen = new Set()
  const push = (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || seen.has(url)) return
    seen.add(url)
    found.push(url)
  }
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6) return
    if (Array.isArray(value)) {
      value.forEach(row => walk(row, depth + 1))
      return
    }
    const list = first(value, ['imageList', 'image_list', 'images', 'pics'])
    if (list) {
      asList(list).forEach((row) => {
        if (typeof row === 'string') push(row)
        else push(first(row, ['urlDefault', 'url_default', 'urlPre', 'url_pre', 'url', 'src']))
      })
      return
    }
    if (/^https?:\/\//.test(String(value.url ?? ''))) push(value.url)
    Object.values(value).forEach(row => walk(row, depth + 1))
  }
  walk(data, 0)
  return found.slice(0, 9)
}

function Mission({ onGoAccount }) {
  return (
    <Empty
      title={t('还没连上小红书 MCP')}
      hint={t('小红书的能力由 xiaohongshu-mcp 服务提供。先在电脑上启动它，再把地址填到这里（手机和电脑要在同一个网络）。')}
      action={<button type="button" className="md-btn is-primary" onClick={onGoAccount}>{t('填写 MCP 地址')}</button>}
    />
  )
}

function StatusDot({ connected }) {
  return <span className={`md-xhs-dot ${connected ? 'is-on' : ''}`} aria-hidden="true" />
}

function NoteCard({ note, onOpen }) {
  return (
    <button type="button" className="md-xhs-note" onClick={() => onOpen(note)}>
      <span className="md-xhs-note-cover">
        {note.cover ? <img src={note.cover} alt="" loading="lazy" draggable={false} /> : <Icon name={note.video ? 'film' : 'image'} size={22} />}
        {note.video ? <span className="md-xhs-note-play"><Icon name="play" size={12} fill /></span> : null}
      </span>
      <strong>{note.title || t('无标题笔记')}</strong>
      <span className="md-xhs-note-meta">
        <span>{note.author || t('小红书用户')}</span>
        {note.liked ? <span className="md-xhs-note-likes"><Icon name="spark" size={11} />{note.liked}</span> : null}
      </span>
    </button>
  )
}

function RawBlock({ data, text }) {
  const [open, setOpen] = React.useState(false)
  const body = data === undefined || data === null ? text : JSON.stringify(data, null, 2)
  if (!body) return null
  return (
    <details className="md-xhs-raw" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t('原始返回')}</summary>
      <pre>{String(body).slice(0, 6000)}</pre>
    </details>
  )
}

function NoteDetail({ note, onClose, onSaved }) {
  const [detail, setDetail] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [comment, setComment] = React.useState('')
  React.useEffect(() => {
    let live = true
    setBusy('detail')
    xhsRequest('call', { tool: 'get_feed_detail', arguments: { feed_id: note.id, xsec_token: note.token } })
      .then((data) => { if (live) setDetail(data) })
      .catch(err => report(err))
      .finally(() => { if (live) setBusy('') })
    return () => { live = false }
  }, [note])

  const images = React.useMemo(() => findImages(detail?.data ?? note.raw), [detail, note])
  const comments = React.useMemo(() => {
    const source = first(detail?.data ?? {}, ['comments', 'commentList', 'comment_list'])
    return asList(first(source ?? {}, ['list', 'items']) ?? source)
      .map(row => ({ text: String(first(row, ['content', 'text', 'note']) ?? ''), user: String(first(first(row, ['user', 'author']) ?? {}, ['nickname', 'nickName', 'name']) ?? '') }))
      .filter(row => row.text)
      .slice(0, 30)
  }, [detail])

  const act = async (tool, label) => {
    setBusy(tool)
    try {
      const data = await xhsRequest('call', { tool, arguments: { feed_id: note.id, xsec_token: note.token } })
      toast(t('{label}成功', { label }))
      setDetail(prev => ({ ...prev, ...data, action: label }))
    } catch (err) {
      report(err)
    } finally {
      setBusy('')
    }
  }

  const sendComment = async (event) => {
    event.preventDefault()
    if (!comment.trim()) return
    setBusy('comment')
    try {
      await xhsRequest('call', { tool: 'post_comment_to_feed', arguments: { feed_id: note.id, xsec_token: note.token, content: comment.trim() } })
      toast(t('评论已发送'))
      setComment('')
    } catch (err) {
      report(err)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    const url = noteUrl(note)
    await dispatchOps([{
      op: 'add_item',
      kind: 'note',
      title: note.title || t('小红书笔记'),
      body: [note.desc, url].filter(Boolean).join('\n\n'),
      source: url,
      platform: '小红书',
      tags: note.tags,
    }], { label: t('存到灵感墙') })
    onSaved?.()
    onClose()
  }

  const body = first(detail?.data ?? {}, ['desc', 'content', 'body'])
  return (
    <Dialog title={note.title || t('笔记详情')} onClose={onClose} width={620}>
      <div className="md-xhs-detail">
        <div className="md-xhs-detail-head">
          <div>
            <p className="md-xhs-detail-author">{note.author || t('小红书用户')}</p>
            <p className="md-muted">{note.liked ? t('{n} 赞', { n: note.liked }) : null}{note.collected ? t(' · {n} 收藏', { n: note.collected }) : null}</p>
          </div>
          <a className="md-btn" href={noteUrl(note)} target="_blank" rel="noreferrer">{t('在小红书打开')}</a>
        </div>
        {images.length ? (
          <div className="md-xhs-detail-images">
            {images.map(src => <img key={src} src={src} alt="" loading="lazy" />)}
          </div>
        ) : null}
        <p className="md-xhs-detail-desc">{typeof body === 'string' && body.trim() ? body : note.desc || t('这条笔记没有文字说明。')}</p>
        {busy === 'detail' ? <p className="md-muted">{t('正在读取详情…')}</p> : null}
        <div className="md-xhs-actions">
          <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={save}><Icon name="plus" size={14} />{t('存到灵感墙')}</button>
          <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => act('like_feed', t('点赞'))}>{t('点赞')}</button>
          <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => act('favorite_feed', t('收藏'))}>{t('收藏')}</button>
        </div>
        <form className="md-xhs-comment" onSubmit={sendComment}>
          <input value={comment} onChange={event => setComment(event.target.value)} placeholder={t('写一条评论…')} aria-label={t('评论')} />
          <button type="submit" className="md-btn is-primary" disabled={busy === 'comment' || !comment.trim()}>{t('发送')}</button>
        </form>
        {comments.length ? (
          <section className="md-xhs-comments">
            <h3>{t('评论')}</h3>
            {comments.map((row, index) => <p key={`${row.user}-${index}`}><b>{row.user || t('小红书用户')}</b>{row.text}</p>)}
          </section>
        ) : null}
        <RawBlock data={detail?.data} text={detail?.text} />
      </div>
    </Dialog>
  )
}

function Discover({ status, onGoAccount }) {
  const [keyword, setKeyword] = React.useState('')
  const [filters, setFilters] = React.useState({ sort_by: SORTS[0], note_type: TYPES[0], publish_time: TIMES[0] })
  const [result, setResult] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [open, setOpen] = React.useState(null)
  const notes = React.useMemo(() => collectNotes(result?.data ?? result?.raw ?? result?.text), [result])

  const run = async (tool, args, key) => {
    setBusy(key)
    try {
      const data = await xhsRequest('call', { tool, arguments: args })
      setResult({ ...data, at: Date.now() })
    } catch (err) {
      report(err)
    } finally {
      setBusy('')
    }
  }

  if (!status?.connected) return <Mission onGoAccount={onGoAccount} />

  const search = (event) => {
    event.preventDefault()
    if (!keyword.trim()) return
    run('search_feeds', { keyword: keyword.trim(), filters }, 'search')
  }

  return (
    <div className="md-xhs-section">
      <form className="md-xhs-search" onSubmit={search}>
        <Icon name="search" size={15} />
        <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder={t('搜小红书：选题、竞品、关键词')} aria-label={t('搜索关键词')} />
        <button type="submit" className="md-btn is-primary" disabled={busy === 'search' || !keyword.trim()}>{busy === 'search' ? t('搜索中…') : t('搜索')}</button>
        <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => run('list_feeds', {}, 'feeds')}>{t('首页推荐')}</button>
      </form>
      <div className="md-xhs-filters">
        {[['sort_by', SORTS], ['note_type', TYPES], ['publish_time', TIMES]].map(([key, options]) => (
          <label key={key} className="md-xhs-filter">
            <span>{t({ sort_by: '排序', note_type: '类型', publish_time: '时间' }[key])}</span>
            <select value={filters[key]} onChange={event => setFilters(prev => ({ ...prev, [key]: event.target.value }))}>
              {options.map(option => <option key={option} value={option}>{t(option)}</option>)}
            </select>
          </label>
        ))}
      </div>
      {busy === 'feeds' ? <p className="md-muted md-xhs-hint">{t('正在读取首页推荐…')}</p> : null}
      {notes.length ? (
        <div className="md-xhs-grid">
          {notes.map(note => <NoteCard key={note.id} note={note} onOpen={setOpen} />)}
        </div>
      ) : result ? (
        <Empty title={t('没有拿到笔记')} hint={t('换个关键词，或者直接看首页推荐。')} action={<RawBlock data={result?.data} text={result?.text} />} />
      ) : (
        <Empty title={t('搜点什么')} hint={t('搜关键词看竞品和选题，或者先看一眼首页推荐；点开笔记可以点赞、收藏、评论，或者存进灵感墙。')} />
      )}
      {open ? <NoteDetail note={open} onClose={() => setOpen(null)} onSaved={() => toast(t('已存到灵感墙'))} /> : null}
    </div>
  )
}

function Publish({ status, onGoAccount }) {
  const [form, setForm] = React.useState({ mode: 'image', title: '', content: '', images: '', tags: '', visibility: VISIBILITY[0], original: false, schedule: '', video: '' })
  const [busy, setBusy] = React.useState(false)
  const [source, setSource] = React.useState('')
  const items = useDesk(state => state.state?.items ?? EMPTY_ITEMS)
  const drafts = React.useMemo(() => items.filter(item => item.production?.article || item.production?.title), [items])
  const patch = payload => setForm(prev => ({ ...prev, ...payload }))

  const fill = (id) => {
    setSource(id)
    const item = items.find(row => row.id === id)
    if (!item) return
    const production = item.production ?? {}
    patch({ title: production.title || item.title || '', content: production.article || item.body || '' })
    toast(t('已把成稿填进来'))
  }

  const submit = async (event) => {
    event.preventDefault()
    const images = form.images.split(/[\n,]/).map(row => row.trim()).filter(Boolean)
    const tags = form.tags.split(/[,，\s]+/).map(row => row.trim()).filter(Boolean)
    const base = { title: form.title.trim(), content: form.content.trim() }
    if (!base.title || !base.content) { toast(t('标题和正文都要填'), { error: true }); return }
    if (form.mode === 'image' && !images.length) { toast(t('至少给一张图片地址'), { error: true }); return }
    if (form.mode === 'video' && !form.video.trim()) { toast(t('填视频文件的绝对路径'), { error: true }); return }
    const args = { ...base, tags, visibility: form.visibility }
    if (form.mode === 'image') args.images = images
    else args.video = form.video.trim()
    if (form.original) args.is_original = true
    if (form.schedule.trim()) {
      const when = Date.parse(form.schedule)
      if (Number.isNaN(when)) { toast(t('定时发布的时间看不懂'), { error: true }); return }
      args.schedule_at = new Date(when).toISOString()
    }
    setBusy(true)
    try {
      const data = await xhsRequest('call', { tool: form.mode === 'image' ? 'publish_content' : 'publish_with_video', arguments: args })
      toast(t('发布请求已交给小红书'))
      setForm(prev => ({ ...prev, content: '' }))
      setSource('')
      // 发布成功就把对应的灵感标成已发布，排期页能对上
      if (source) dispatchOps([{ op: 'set_status', id: source, status: 'published' }], { label: t('标记为已发布') })
      if (data?.text) toast(data.text.slice(0, 60))
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  if (!status?.connected) return <Mission onGoAccount={onGoAccount} />

  return (
    <form className="md-xhs-section md-xhs-form" onSubmit={submit}>
      <div className="md-xhs-form-head">
        <Segmented
          label={t('发布类型')}
          value={form.mode}
          onChange={mode => patch({ mode })}
          options={[{ value: 'image', label: t('图文'), icon: 'image' }, { value: 'video', label: t('视频'), icon: 'film' }]}
        />
        {drafts.length ? (
          <>
            <span className="md-xhs-spacer" />
            <label className="md-xhs-filter">
              <span>{t('从成稿带入')}</span>
              <select value={source} onChange={event => fill(event.target.value)}>
                <option value="">{t('选一条成稿')}</option>
                {drafts.map(item => <option key={item.id} value={item.id}>{item.production?.title || item.title}</option>)}
              </select>
            </label>
          </>
        ) : null}
      </div>
      <label className="md-field">
        <span>{t('标题')}</span>
        <input value={form.title} maxLength={20} onChange={event => patch({ title: event.target.value })} placeholder={t('小红书标题最多 20 个字')} />
      </label>
      <label className="md-field">
        <span>{t('正文')}</span>
        <textarea rows={9} value={form.content} onChange={event => patch({ content: event.target.value })} placeholder={t('正文、话题都能写在这里；话题也可以单独填在下面。')} />
      </label>
      {form.mode === 'image' ? (
        <label className="md-field">
          <span>{t('图片地址')}</span>
          <textarea rows={3} value={form.images} onChange={event => patch({ images: event.target.value })} placeholder={'https://example.com/1.jpg\nhttps://example.com/2.jpg'} />
          <small>{t('每行一个 http(s) 图片地址。MCP 服务要能访问到这些图，所以本机工作台里的图片得先有公网地址。')}</small>
        </label>
      ) : (
        <label className="md-field">
          <span>{t('视频文件路径')}</span>
          <input value={form.video} onChange={event => patch({ video: event.target.value })} placeholder="/Users/you/Videos/clip.mp4" />
          <small>{t('MCP 服务所在电脑上的视频绝对路径。')}</small>
        </label>
      )}
      <div className="md-field-row">
        <label className="md-field">
          <span>{t('话题标签')}</span>
          <input value={form.tags} onChange={event => patch({ tags: event.target.value })} placeholder={t('用逗号分隔，如：效率工具, 独立开发')} />
        </label>
        <label className="md-field">
          <span>{t('可见范围')}</span>
          <select value={form.visibility} onChange={event => patch({ visibility: event.target.value })}>
            {VISIBILITY.map(option => <option key={option} value={option}>{t(option)}</option>)}
          </select>
        </label>
      </div>
      <div className="md-field-row">
        <label className="md-field">
          <span>{t('定时发布')}</span>
          <input type="datetime-local" value={form.schedule} onChange={event => patch({ schedule: event.target.value })} />
          <small>{t('留空就是现在发；小红书只接受 1 小时到 14 天之间。')}</small>
        </label>
        <label className="md-field md-xhs-check">
          <span>{t('声明原创')}</span>
          <input type="checkbox" checked={form.original} onChange={event => patch({ original: event.target.checked })} />
        </label>
      </div>
      <div className="md-form-foot">
        <span className="md-muted md-xhs-hint">{t('发布会在 MCP 服务那边真的操作小红书网页，请确认内容已经改好。')}</span>
        <span style={{ flex: 1 }} />
        <button type="submit" className="md-btn is-primary" disabled={busy}>{busy ? t('发布中…') : t('发布到小红书')}</button>
      </div>
    </form>
  )
}

function Account({ status, onStatus }) {
  const [url, setUrl] = React.useState(status?.url ?? '')
  const [token, setToken] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [login, setLogin] = React.useState(null)
  const [qrcode, setQrcode] = React.useState('')

  React.useEffect(() => { setUrl(status?.url ?? '') }, [status?.url])

  const save = async (event) => {
    event.preventDefault()
    setBusy('save')
    try {
      const next = await xhsRequest('config', { url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) })
      onStatus(next)
      setToken('')
      if (next.connected) toast(t('已连上 MCP 服务'))
      else toast(next.error || t('还连不上，检查地址和服务'), { error: true })
    } catch (err) {
      report(err)
    } finally {
      setBusy('')
    }
  }

  const call = async (tool, key) => {
    setBusy(key)
    try {
      const data = await xhsRequest('call', { tool, arguments: {} })
      setLogin({ text: data.text, data: data.data })
      if (tool === 'get_login_qrcode') {
        const raw = typeof data.text === 'string' ? data.text : ''
        const match = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/.exec(raw) || /[A-Za-z0-9+/=]{400,}/.exec(raw)
        setQrcode(match ? (match[0].startsWith('data:') ? match[0] : `data:image/png;base64,${match[0]}`) : '')
      }
      return data
    } catch (err) {
      report(err)
      return null
    } finally {
      setBusy('')
    }
  }

  const logout = () => setDesk({
    dialog: {
      title: t('退出小红书登录？'),
      submitLabel: t('退出登录'),
      fields: [],
      onSubmit: async () => {
        if (await call('delete_cookies', 'logout')) {
          setQrcode('')
          setLogin({ text: t('已经退出，重新扫码登录。') })
        }
      },
    },
  })

  return (
    <div className="md-xhs-section">
      <form className="md-xhs-connect" onSubmit={save}>
        <label className="md-field">
          <span>{t('MCP 服务地址')}</span>
          <input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://192.168.1.10:18060/mcp" />
          <small>{t('xiaohongshu-mcp 的地址。手机和跑服务的电脑要在同一个网络；也可以用内网穿透的公网地址。')}</small>
        </label>
        <label className="md-field">
          <span>{t('访问令牌（可选）')}</span>
          <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={status?.tokenSet ? t('已保存，留空表示不改') : t('服务启动时如果设了 AUTH_TOKEN，就填在这里')} />
        </label>
        <div className="md-form-foot">
          <span className="md-xhs-state">
            <StatusDot connected={Boolean(status?.connected)} />
            {status?.connected
              ? t('已连接 {name} {version}', { name: status.server?.name ?? 'MCP', version: status.server?.version ?? '' })
              : t('未连接')}
          </span>
          <span style={{ flex: 1 }} />
          <button type="submit" className="md-btn is-primary" disabled={busy === 'save'}>{busy === 'save' ? t('连接中…') : t('保存并连接')}</button>
        </div>
        {status?.error ? <p className="md-xhs-error">{status.error}</p> : null}
      </form>

      <section className="md-xhs-card">
        <header>
          <h3>{t('登录小红书')}</h3>
          <span className="md-muted">{t('MCP 服务用一个浏览器登录小红书，扫码一次就好。')}</span>
        </header>
        <div className="md-xhs-actions">
          <button type="button" className="md-btn" disabled={!status?.connected || Boolean(busy)} onClick={() => call('check_login_status', 'check')}>{t('检查登录状态')}</button>
          <button type="button" className="md-btn" disabled={!status?.connected || Boolean(busy)} onClick={() => call('get_login_qrcode', 'qrcode')}>{t('获取登录二维码')}</button>
          <button type="button" className="md-btn" disabled={!status?.connected || Boolean(busy)} onClick={logout}>{t('退出登录')}</button>
        </div>
        {qrcode ? (
          <div className="md-xhs-qrcode">
            <img src={qrcode} alt={t('小红书登录二维码')} />
            <p className="md-muted">{t('用小红书 App 扫这个码，扫完点一次「检查登录状态」。')}</p>
          </div>
        ) : null}
        {login ? <p className="md-xhs-login">{login.text || JSON.stringify(login.data)}</p> : null}
        <RawBlock data={login?.data} text={qrcode ? '' : login?.text} />
      </section>

      <section className="md-xhs-card">
        <header>
          <h3>{t('可用工具')}</h3>
          <span className="md-muted">{t('服务公布了 {n} 个工具，界面按它们自动接。', { n: status?.tools?.length ?? 0 })}</span>
        </header>
        <ul className="md-xhs-tools">
          {(status?.tools ?? []).map(tool => <li key={tool.name}><code>{tool.name}</code><span>{tool.description ?? ''}</span></li>)}
        </ul>
      </section>

      <section className="md-xhs-card">
        <header>
          <h3>{t('怎么把服务跑起来')}</h3>
        </header>
        <ol className="md-xhs-steps">
          <li>{t('在电脑上下载 xiaohongshu-mcp 的对应版本（macOS Apple 芯片、Windows x64、Linux x64），先运行登录程序扫码。')}</li>
          <li>{t('启动 MCP 服务，默认监听 18060 端口。')}</li>
          <li>{t('把地址填成 http://电脑的局域网 IP:18060/mcp，保存并连接。')}</li>
        </ol>
        <p className="md-muted md-xhs-hint">{t('这个项目目前没有 Linux ARM64 的官方二进制，所以暂时没法直接跑在手机上；服务跑在哪台机器上，图片和视频路径就要能在哪台机器上访问。')}</p>
      </section>
    </div>
  )
}

export function XhsView() {
  useLang()
  const [section, setSection] = React.useState('discover')
  const [status, setStatus] = React.useState(null)
  const [checking, setChecking] = React.useState(false)

  const refresh = React.useCallback(async (silent = false) => {
    setChecking(true)
    try {
      const next = await xhsRequest('status')
      setStatus(next)
      return next
    } catch (err) {
      if (!silent) report(err)
      return null
    } finally {
      setChecking(false)
    }
  }, [])

  React.useEffect(() => { refresh(true) }, [refresh])

  const goAccount = () => setSection('account')
  return (
    <div className="md-page md-xhs-page">
      <header className="md-page-head">
        <div>
          <h1>{t('小红书')}</h1>
          <p className="md-page-sub">{t('搜选题、看竞品、发笔记。数据来自 xiaohongshu-mcp，成稿可以直接从工作台带过来。')}</p>
        </div>
        <span style={{ flex: 1 }} />
        <span className="md-xhs-pill"><StatusDot connected={Boolean(status?.connected)} />{status?.connected ? t('已连接') : t('未连接')}</span>
        <button type="button" className="md-btn" disabled={checking} onClick={() => refresh()}>{checking ? t('检查中…') : t('重新连接')}</button>
      </header>
      <div className="md-xhs-tabs">
        <Segmented label={t('小红书分区')} value={section} onChange={setSection} options={SECTIONS.map(row => ({ value: row.id, label: t(row.label), icon: row.icon }))} />
      </div>
      {section === 'discover' ? <Discover status={status} onGoAccount={goAccount} /> : null}
      {section === 'publish' ? <Publish status={status} onGoAccount={goAccount} /> : null}
      {section === 'account' ? <Account status={status} onStatus={setStatus} /> : null}
    </div>
  )
}