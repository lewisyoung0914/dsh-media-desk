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
// 本地 MCP 服务（Node 版）地址：小红书 CDN 有防盗链，图片统一走它代理
const LOCAL_MCP = 'http://127.0.0.1:18060'

/** 小红书图床要 Referer，浏览器直链会 403，交给本地 MCP 代取。 */
function proxied(url) {
  const value = String(url ?? '')
  if (!value) return ''
  if (!/^https?:/i.test(value)) return value
  if (!/xhscdn\.com|xhscdn\.net/.test(value)) return value
  return `${LOCAL_MCP}/img?u=${encodeURIComponent(value)}`
}

/** 把本机文件上传给本地 MCP，拿回绝对路径（发布时直接用它）。 */
async function uploadLocal(file) {
  const res = await fetch(`${LOCAL_MCP}/upload`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.path) throw new Error(data.error || t('上传失败'))
  return data
}

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
        const authorFlat = first(card, ['author', 'nickname']) ?? first(value, ['author', 'nickname'])
        const user = first(card, ['user', 'author_obj']) ?? {}
        const interact = first(card, ['interactInfo', 'interact_info', 'interactions']) ?? {}
        const type = first(card, ['type']) ?? ''
        const tags = asList(first(card, ['tagList', 'tag_list', 'tags'])).map(tag => (typeof tag === 'string' ? tag : first(tag, ['name', 'title']))).filter(Boolean)
        notes.push({
          id: key,
          token: String(token ?? ''),
          title: typeof title === 'string' ? title : '',
          desc: String(pick(['desc', 'content', 'body', 'description']) ?? ''),
          cover: typeof coverUrl === 'string' ? coverUrl : '',
          author: String(first(user, ['nickname', 'nickName', 'nick_name', 'name']) ?? authorFlat ?? ''),
          liked: String(first(interact, ['likedCount', 'liked_count', 'liked']) ?? pick(['liked_count', 'likedCount', 'liked']) ?? ''),
          collected: String(first(interact, ['collectedCount', 'collected_count']) ?? pick(['collected_count', 'collectedCount']) ?? ''),
          comments: String(first(interact, ['commentCount', 'comment_count']) ?? pick(['comment_count', 'commentCount']) ?? ''),
          video: Boolean(pick(['video'])) || String(type).toLowerCase().includes('video'),
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
      hint={t('小红书的操作由一个本地 MCP 服务驱动（Node + 本机 Chromium）：用 ~/xhsctl.sh start 启动，地址填 http://127.0.0.1:18060/mcp。想改用电脑上的官方 xiaohongshu-mcp，把地址换成电脑的局域网 IP 也行。')}
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
        {note.cover ? <img src={proxied(note.cover)} alt="" loading="lazy" draggable={false} onError={event => { event.currentTarget.style.display = 'none' }} /> : <Icon name={note.video ? 'film' : 'image'} size={22} />}
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
  const [moreComments, setMoreComments] = React.useState(null)
  const [moreBusy, setMoreBusy] = React.useState(false)
  React.useEffect(() => {
    let live = true
    setBusy('detail')
    xhsRequest('call', { tool: 'get_feed_detail', arguments: { feed_id: note.id, xsec_token: note.token } })
      .then((data) => { if (live) setDetail(data) })
      .catch(err => report(err))
      .finally(() => { if (live) setBusy('') })
    return () => { live = false }
  }, [note])

  // 我们的本地 MCP 返回 { note: {...} }，官方 mock 是平铺结构，两种都认
  const payload = detail?.data?.note ?? detail?.data ?? {}
  const images = React.useMemo(() => findImages(payload).concat(findImages(note.raw)).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 9), [payload, note])
  const comments = React.useMemo(() => {
    if (Array.isArray(payload.comments)) {
      return payload.comments.map(row => ({ text: String(first(row, ['content', 'text', 'note']) ?? ''), user: String(first(row, ['user', 'author']) ?? (typeof row.user === 'string' ? row.user : '')) })).filter(row => row.text).slice(0, 30)
    }
    const source = first(payload, ['comments', 'commentList', 'comment_list'])
    return asList(first(source ?? {}, ['list', 'items']) ?? source)
      .map(row => ({ text: String(first(row, ['content', 'text', 'note']) ?? ''), user: String(first(first(row, ['user', 'author']) ?? {}, ['nickname', 'nickName', 'name']) ?? '') }))
      .filter(row => row.text)
      .slice(0, 30)
  }, [payload])

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

  const shownComments = moreComments ?? comments
  const commentTotal = Number(String(payload.comment_count ?? '').replace(/[^\d]/g, '')) || 0
  const loadMoreComments = async () => {
    setMoreBusy(true)
    try {
      const data = await xhsRequest('call', { tool: 'get_feed_detail', arguments: { feed_id: note.id, xsec_token: note.token, load_all_comments: true, limit: 60 } })
      const next = data?.data?.note?.comments
      if (Array.isArray(next)) setMoreComments(next.map(row => ({ text: String(row.content ?? ''), user: String(row.user ?? '') })))
      else toast(t('没加载到更多评论'))
    } catch (err) {
      report(err)
    } finally {
      setMoreBusy(false)
    }
  }
  const videoUrl = String(first(payload, ['video_url', 'videoUrl']) ?? '')
  const videoCover = String(first(payload, ['video_cover', 'videoCover']) ?? '') || images[0] || note.cover

  const body = first(payload, ['desc', 'content', 'body', 'description'])
  const detailTitle = String(first(payload, ['title']) ?? '') || note.title
  const detailAuthor = String(first(payload, ['author', 'nickname']) ?? '') || note.author
  const detailLiked = String(first(payload, ['liked_count', 'likedCount']) ?? '') || note.liked
  return (
    <Dialog title={detailTitle || t('笔记详情')} onClose={onClose} width={620}>
      <div className="md-xhs-detail">
        <div className="md-xhs-detail-head">
          <div>
            <p className="md-xhs-detail-author">{detailAuthor || t('小红书用户')}</p>
            <p className="md-muted">{detailLiked ? t('{n} 赞', { n: detailLiked }) : null}{note.collected ? t(' · {n} 收藏', { n: note.collected }) : null}</p>
          </div>
          <a className="md-btn" href={noteUrl(note)} target="_blank" rel="noreferrer">{t('在小红书打开')}</a>
        </div>
        {videoUrl ? (
          <video className="md-xhs-detail-video" controls playsInline preload="metadata"
            poster={videoCover ? proxied(videoCover) : undefined}
            src={proxied(videoUrl)} />
        ) : images.length ? (
          <div className="md-xhs-detail-images">
            {images.map(src => <img key={src} src={proxied(src)} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />)}
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
        {shownComments.length ? (
          <section className="md-xhs-comments">
            <h3>{t('评论')}{commentTotal ? <span className="md-muted"> · {t('已显示 {n}/{total}', { n: shownComments.length, total: commentTotal })}</span> : null}</h3>
            {shownComments.map((row, index) => <p key={`${row.user}-${index}`}><b>{row.user || t('小红书用户')}</b>{row.text}</p>)}
            {commentTotal > shownComments.length || (!moreComments && shownComments.length >= 10) ? (
              <button type="button" className="md-btn is-small" disabled={moreBusy} onClick={loadMoreComments}>
                {moreBusy ? t('加载中…') : t('加载更多评论')}
              </button>
            ) : null}
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
  const [localFiles, setLocalFiles] = React.useState([])
  const [autoPublish, setAutoPublish] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const localInput = React.useRef(null)
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

  const pickLocal = async (event) => {
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        const data = await uploadLocal(file)
        const kind = String(file.type).startsWith('video') ? 'video' : 'image'
        setLocalFiles(prev => [...prev, { path: data.path, name: file.name, src: `${LOCAL_MCP}${data.src}`, kind }])
      }
      toast(t('已加入本机文件'))
    } catch (err) {
      report(err)
    } finally {
      setUploading(false)
      if (localInput.current) localInput.current.value = ''
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    const urlImages = form.images.split(/[\n,]/).map(row => row.trim()).filter(Boolean)
    const localImages = localFiles.filter(row => row.kind === 'image').map(row => row.path)
    const images = [...urlImages, ...localImages]
    const localVideo = localFiles.find(row => row.kind === 'video')?.path ?? ''
    const tags = form.tags.split(/[,，\s]+/).map(row => row.trim()).filter(Boolean)
    const base = { title: form.title.trim(), content: form.content.trim() }
    if (!base.title || !base.content) { toast(t('标题和正文都要填'), { error: true }); return }
    if (form.mode === 'image' && !images.length) { toast(t('至少给一张图片：填网络地址或选本机图片'), { error: true }); return }
    if (form.mode === 'video' && !localVideo && !form.video.trim()) { toast(t('选一个本机视频，或填服务所在机器的视频路径'), { error: true }); return }
    const args = { ...base, tags, visibility: form.visibility }
    if (form.mode === 'image') args.images = images
    else args.video = localVideo || form.video.trim()
    if (form.original) args.is_original = true
    if (autoPublish) args.confirm = true
    if (form.schedule.trim()) {
      const when = Date.parse(form.schedule)
      if (Number.isNaN(when)) { toast(t('定时发布的时间看不懂'), { error: true }); return }
      args.schedule_at = new Date(when).toISOString()
    }
    setBusy(true)
    try {
      const data = await xhsRequest('call', { tool: form.mode === 'image' ? 'publish_content' : 'publish_with_video', arguments: args })
      const stage = data?.data?.stage
      if (stage === 'ready_to_publish') {
        toast(t('已上传并填好，到小红书创作中心确认后点发布'))
      } else {
        toast(t('已提交发布，稍后到小红书看看'))
        setForm(prev => ({ ...prev, content: '' }))
        setSource('')
        setLocalFiles([])
        // 发布成功就把对应的灵感标成已发布，排期页能对上
        if (source) dispatchOps([{ op: 'set_status', id: source, status: 'published' }], { label: t('标记为已发布') })
      }
      if (data?.text && stage !== 'ready_to_publish') toast(data.text.slice(0, 60))
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
          <small>{t('每行一个 http(s) 图片地址，或者用下面的「选择本机图片/视频」直接选设备上的文件。')}</small>
        </label>
      ) : (
        <label className="md-field">
          <span>{t('视频文件路径')}</span>
          <input value={form.video} onChange={event => patch({ video: event.target.value })} placeholder="/Users/you/Videos/clip.mp4" />
          <small>{t('可以选本机视频；也可以填 MCP 服务所在机器上的视频绝对路径（用电脑版服务时）。')}</small>
        </label>
      )}
      <div className="md-xhs-local">
        <button type="button" className="md-btn" onClick={() => localInput.current?.click()} disabled={uploading}>
          <Icon name="upload" size={14} />{uploading ? t('上传中…') : t('选择本机图片/视频')}
        </button>
        <input ref={localInput} type="file" hidden multiple accept="image/*,video/*" onChange={pickLocal} />
        <span className="md-muted md-xhs-hint">{t('本机文件会先传到本机 MCP，再由它上传到小红书；不用先传到网上的图床。')}</span>
      </div>
      {localFiles.length ? (
        <div className="md-xhs-local-list">
          {localFiles.map(file => (
            <span key={file.path} className="md-xhs-local-item">
              {file.kind === 'image' ? <img src={file.src} alt="" /> : <Icon name="film" size={14} />}
              <span>{file.name}</span>
              <button type="button" aria-label={t('移除')} onClick={() => setLocalFiles(prev => prev.filter(row => row.path !== file.path))}><Icon name="close" size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
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
      <label className="md-field md-xhs-check">
        <span>{t('填好后直接点发布（不勾就停在待发布，由你去创作中心确认）')}</span>
        <input type="checkbox" checked={autoPublish} onChange={event => setAutoPublish(event.target.checked)} />
      </label>
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
          <li>{t('这台设备上装的是本地 Node 版 MCP：在终端执行 ~/xhsctl.sh start 启动，~/xhsctl.sh stop 停止，日志在 ~/xhs-mcp-node/server.log。')}</li>
          <li>{t('地址填 http://127.0.0.1:18060/mcp，保存并连接（MCP 服务默认就监听 18060）。')}</li>
          <li>{t('到「账号」里点「获取登录二维码」，用小红书 App 扫码；登录状态存在本机的浏览器配置里，下次不用再扫。')}</li>
        </ol>
        <p className="md-muted md-xhs-hint">{t('也可以用电脑上的官方 xiaohongshu-mcp：地址换成电脑局域网 IP 即可，两条路都支持；图片发布用 http(s) 图片地址，视频用服务所在机器上的绝对路径。')}</p>
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