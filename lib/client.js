/**
 * dsh-image2-draw — image2 生图插件（浏览器半）。
 *
 * 仿官方 web-search 卡片（WebSearchCard）形态，注册进 设置 → 插件 → 插件配置
 * （settings.plugin.item）：统一配置「API Key + 接口地址」，接口地址输入框
 * placeholder 默认显示接口格式。
 *
 * 数据通道：命名空间 image2-draw 不在 apiproxy 白名单，走插件自有
 * /image2-draw/* 路由；密钥走官方 credentials RPC（无白名单）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-image2-draw',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'image2-draw'
    const DEFAULT_KEY_ENV = 'IMAGE2_API_KEY'

    const zh = {
      nav: 'Image2 生图',
      cardDesc: '配置 image2 生图 API：统一设置 API Key 与接口地址，文生图/图生图',
      expand: '展开',
      collapse: '折叠',
      unsaved: '有未保存的修改',
      loading: '正在读取配置...',
      loadFailed: '读取失败',
      saveFailed: '保存失败',
      saved: '已保存',
      save: '保存',
      saving: '保存中...',
      refresh: '刷新',
      conflict: '配置已被其他页面修改，请刷新后重试。',
      notWritable: '当前设置只读，无法修改。',
      apiKey: 'API Key',
      apiKeyHint: '写入凭据存储（IMAGE2_API_KEY），不回显；与接口地址一起保存后生效',
      keySet: '已配置',
      keyUnset: '未配置',
      baseUrl: '接口地址',
      baseUrlHint: '未以 /images/generations 结尾会自动补全；留空则无法生图',
      model: '模型',
      modelHint: '留空使用默认 gpt-image-2',
      editUrl: '图生图端点（可选）',
      editUrlHint: '留空时由接口地址自动推导 /images/edits',
      timeout: '超时（秒）',
      timeoutHint: '请求超时时间，范围 1~3600，默认 180',
      invalidUrl: '必须是合法的 http(s) URL',
      invalidNumber: '必须是 1~3600 的整数',
    }

    const en = {
      nav: 'Image2 Draw',
      cardDesc: 'Configure the image2 API: one API key and endpoint for text/image generation',
      expand: 'Expand',
      collapse: 'Collapse',
      unsaved: 'Unsaved changes',
      loading: 'Loading configuration...',
      loadFailed: 'Failed to load',
      saveFailed: 'Failed to save',
      saved: 'Saved',
      save: 'Save',
      saving: 'Saving...',
      refresh: 'Refresh',
      conflict: 'Settings changed elsewhere. Refresh and try again.',
      notWritable: 'Settings are read-only here.',
      apiKey: 'API Key',
      apiKeyHint: 'Stored in credentials (IMAGE2_API_KEY), write-only; applied together with the endpoint on save',
      keySet: 'Configured',
      keyUnset: 'Missing',
      baseUrl: 'Endpoint',
      baseUrlHint: '/images/generations is appended when missing; leave blank to disable generation',
      model: 'Model',
      modelHint: 'Defaults to gpt-image-2 when blank',
      editUrl: 'Edit endpoint (optional)',
      editUrlHint: 'Derived as /images/edits from the endpoint when blank',
      timeout: 'Timeout (s)',
      timeoutHint: 'Request timeout from 1 to 3600, default 180',
      invalidUrl: 'Must be a valid http(s) URL',
      invalidNumber: 'Must be an integer from 1 to 3600',
    }

    /* ------------------------- 纯函数（__test） ------------------------- */

    function objectOf(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function keyRefOf(value) {
      const env = String(objectOf(value).apiKeyEnv ?? '').trim()
      return env.length > 0 ? env : DEFAULT_KEY_ENV
    }

    /** 由命名空间值生成表单草稿（文本形态）。 */
    function draftsOf(value) {
      const source = objectOf(value)
      return {
        baseURL: typeof source.baseURL === 'string' ? source.baseURL : '',
        model: typeof source.model === 'string' ? source.model : '',
        editURL: typeof source.editURL === 'string' ? source.editURL : '',
        timeoutSeconds: source.timeoutSeconds === undefined ? '' : String(source.timeoutSeconds),
      }
    }

    /** 保存用的 mutate ops：空草稿 → unset（回继承默认），非空 → set。 */
    function opsFor(drafts, selectedFields) {
      const ops = []
      const fields = selectedFields ?? ['baseURL', 'model', 'editURL', 'timeoutSeconds']
      for (const field of fields) {
        const draft = String(drafts[field] ?? '').trim()
        if (draft === '') {
          ops.push({ op: 'unset', path: [field] })
        } else {
          const value = field === 'timeoutSeconds' ? Number(draft) : draft
          ops.push({ op: 'set', path: [field], value })
        }
      }
      return ops
    }

    function isValidBaseUrl(text) {
      const value = String(text ?? '').trim()
      if (value === '') return true
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    }

    function isValidTimeout(text) {
      const value = String(text ?? '').trim()
      if (value === '') return true
      if (!/^\d+$/.test(value)) return false
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3600
    }

    function dirtyOf(settingsDirty, keyDraft) {
      return settingsDirty === true || String(keyDraft ?? '').trim() !== ''
    }

    function savePlan(settingsDirty, keyDraft) {
      return {
        mutateSettings: settingsDirty === true,
        writeKey: String(keyDraft ?? '').trim() !== '',
      }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * 调用插件自有 HTTP API（/image2-draw/*）。
     * 返回 { ok:true, value }；冲突/业务错误抛带 code 的 Error。
     */
    async function fetchJson(path, body) {
      const response = await fetch(path, body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`Image2 服务返回异常（HTTP ${response.status}）`)
      }
      if (response.status !== 200 || payload?.ok !== true) {
        const error = payload?.error ?? {}
        const failure = new Error(error.message ?? `Image2 服务错误（HTTP ${response.status}）`)
        failure.code = error.code ?? 'unknown'
        throw failure
      }
      return payload.value
    }

    /* ------------------------------ 组件 ------------------------------ */

    function Field(props) {
      const { id, label, hint, text, placeholder, disabled, invalid, invalidLabel, onEdit } = props
      return h('div', { className: 'dsh-i2-field' },
        h('div', { className: 'dsh-i2-field-head' },
          h('label', { className: 'dsh-i2-label', htmlFor: id }, label)),
        h('input', {
          id,
          className: invalid ? 'dsh-i2-input dsh-i2-input-invalid' : 'dsh-i2-input',
          type: 'text',
          value: text,
          placeholder: placeholder ?? '',
          disabled,
          onChange: event => onEdit(event.target.value),
        }),
        h('p', { className: invalid ? 'dsh-i2-invalid' : 'dsh-i2-hint' }, invalid ? invalidLabel : hint))
    }

    function KeyField(props) {
      const { label, hint, text, disabled, configured, stateLabel, onEdit } = props
      return h('div', { className: 'dsh-i2-field' },
        h('div', { className: 'dsh-i2-field-head' },
          h('label', { className: 'dsh-i2-label' }, label),
          h('span', { className: configured ? 'dsh-i2-badge dsh-i2-badge-ok' : 'dsh-i2-badge' }, stateLabel)),
        h('input', {
          className: 'dsh-i2-input',
          type: 'password',
          name: 'image2-api-key',
          autoComplete: 'new-password',
          spellCheck: false,
          value: text,
          disabled,
          onChange: event => onEdit(event.target.value),
        }),
        h('p', { className: 'dsh-i2-hint' }, hint))
    }

    function Image2DrawForm(props) {
      const { api, remote, t, onDirtyChange } = props
      const [status, setStatus] = useState('loading')
      const [writable, setWritable] = useState(false)
      const [view, setView] = useState(undefined)
      const [drafts, setDrafts] = useState({ baseURL: '', model: '', editURL: '', timeoutSeconds: '' })
      const [keyDraft, setKeyDraft] = useState('')
      const [keyConfigured, setKeyConfigured] = useState(false)
      const [keyWritable, setKeyWritable] = useState(true)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState('')
      const [notice, setNotice] = useState('')
      const [dirty, setDirty] = useState(false)
      const dirtyRef = useRef(false)
      const settingsDirtyRef = useRef(false)
      const keyDraftRef = useRef('')
      const dirtyFieldsRef = useRef(new Set())

      const syncDirty = useCallback((settingsDirty, nextKeyDraft) => {
        settingsDirtyRef.current = settingsDirty
        keyDraftRef.current = nextKeyDraft
        setKeyDraft(nextKeyDraft)
        const nextDirty = dirtyOf(settingsDirty, nextKeyDraft)
        setDirty(nextDirty)
        dirtyRef.current = nextDirty
        onDirtyChange?.(nextDirty)
      }, [onDirtyChange])

      const load = useCallback(async (preserveDrafts = false) => {
        setStatus('loading')
        setFailure('')
        try {
          const state = await fetchJson('/image2-draw/state')
          setWritable(state.writable === true)
          setView({ value: state.value ?? {}, revision: state.revision ?? 0 })
          if (!preserveDrafts) {
            setDrafts(draftsOf(state.value))
            dirtyFieldsRef.current.clear()
            syncDirty(false, '')
          }
          setStatus('ready')
          try {
            const credResponse = await api.credentials.describe({ refs: [keyRefOf(state.value)] })
            if (credResponse.result.ok) {
              const cred = credResponse.result.value.credentials?.[keyRefOf(state.value)]
              setKeyConfigured(cred?.configured === true)
              setKeyWritable(cred?.writable !== false)
            }
          } catch {
            setKeyConfigured(false)
          }
        } catch (error) {
          setFailure(messageOf(error))
          setStatus('error')
        }
      }, [api.credentials, syncDirty])

      useEffect(() => {
        void load(false)
        const disposeSettings = remote.$on('settings/document-updated', (ns) => {
          if (ns === NS && !dirtyRef.current) void load(false)
        })
        return () => { disposeSettings() }
      }, [load, remote])

      const editField = (field, text) => {
        setDrafts(current => ({ ...current, [field]: text }))
        dirtyFieldsRef.current.add(field)
        syncDirty(true, keyDraftRef.current)
        setNotice('')
      }

      const editKey = (text) => {
        syncDirty(settingsDirtyRef.current, text)
        setNotice('')
      }

      const save = async () => {
        if (view === undefined || !writable || busy || !dirtyRef.current) return
        if (!isValidBaseUrl(drafts.baseURL) || !isValidBaseUrl(drafts.editURL) || !isValidTimeout(drafts.timeoutSeconds)) return
        setBusy(true)
        setFailure('')
        setNotice('')
        let acceptedView = view
        const plan = savePlan(settingsDirtyRef.current, keyDraftRef.current)
        try {
          if (plan.mutateSettings) {
            try {
              const next = await fetchJson('/image2-draw/mutate', {
                ops: opsFor(drafts, dirtyFieldsRef.current),
                expectedRevision: view.revision,
              })
              acceptedView = { value: next.value ?? {}, revision: next.revision ?? 0 }
              setView(acceptedView)
              setDrafts(draftsOf(next.value))
              dirtyFieldsRef.current.clear()
              syncDirty(false, keyDraftRef.current)
            } catch (error) {
              if (error.code === 'settings-conflict') {
                await load(true)
                setFailure(t('conflict'))
              } else {
                setFailure(messageOf(error))
              }
              return
            }
          }

          const key = keyDraftRef.current.trim()
          if (plan.writeKey) {
            try {
              const response = await api.credentials.set({ ref: keyRefOf(acceptedView.value), value: key })
              if (!response.result.ok) {
                setFailure(response.result.error.message)
                return
              }
              setKeyConfigured(true)
            } catch (error) {
              setFailure(messageOf(error))
              return
            }
          }
          // 输入在保存期间禁用，因此成功后可在一个出口原子清空所有草稿标记。
          dirtyFieldsRef.current.clear()
          syncDirty(false, '')
          setNotice(t('saved'))
        } finally {
          setBusy(false)
        }
      }

      if (status === 'loading') {
        return h('div', { className: 'dsh-i2-form' }, h('p', { className: 'dsh-i2-muted' }, t('loading')))
      }
      if (status === 'error') {
        return h('div', { className: 'dsh-i2-form' },
          h('p', { className: 'dsh-i2-error' }, `${t('loadFailed')}: ${failure}`),
          h('button', { className: 'dsh-i2-secondary', type: 'button', onClick: () => void load(false) }, t('refresh')))
      }

      const invalid = !isValidBaseUrl(drafts.baseURL)
        || !isValidBaseUrl(drafts.editURL)
        || !isValidTimeout(drafts.timeoutSeconds)
      return h('div', { className: 'dsh-i2-form' },
        failure ? h('p', { className: 'dsh-i2-error', role: 'alert' }, failure) : null,
        notice ? h('p', { className: 'dsh-i2-success', role: 'status' }, notice) : null,
        !writable ? h('p', { className: 'dsh-i2-muted' }, t('notWritable')) : null,
        h('div', { className: 'dsh-i2-fields' },
          h(KeyField, {
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            text: keyDraft,
            disabled: !writable || busy || !keyWritable,
            configured: keyConfigured,
            stateLabel: keyConfigured ? t('keySet') : t('keyUnset'),
            onEdit: editKey,
          }),
          h(Field, {
            id: 'image2-base-url',
            label: t('baseUrl'),
            hint: t('baseUrlHint'),
            text: drafts.baseURL,
            placeholder: 'https://example.com/v1',
            disabled: !writable || busy,
            invalid: !isValidBaseUrl(drafts.baseURL),
            invalidLabel: t('invalidUrl'),
            onEdit: text => editField('baseURL', text),
          }),
          h(Field, {
            id: 'image2-model',
            label: t('model'),
            hint: t('modelHint'),
            text: drafts.model,
            placeholder: 'gpt-image-2',
            disabled: !writable || busy,
            invalid: false,
            invalidLabel: '',
            onEdit: text => editField('model', text),
          }),
          h(Field, {
            id: 'image2-edit-url',
            label: t('editUrl'),
            hint: t('editUrlHint'),
            text: drafts.editURL,
            placeholder: 'https://example.com/v1/images/edits',
            disabled: !writable || busy,
            invalid: !isValidBaseUrl(drafts.editURL),
            invalidLabel: t('invalidUrl'),
            onEdit: text => editField('editURL', text),
          }),
          h(Field, {
            id: 'image2-timeout',
            label: t('timeout'),
            hint: t('timeoutHint'),
            text: drafts.timeoutSeconds,
            placeholder: '180',
            disabled: !writable || busy,
            invalid: !isValidTimeout(drafts.timeoutSeconds),
            invalidLabel: t('invalidNumber'),
            onEdit: text => editField('timeoutSeconds', text),
          })),
        h('div', { className: 'dsh-i2-footer' },
          h('button', {
            type: 'button',
            className: 'dsh-i2-save',
            disabled: !writable || busy || !dirty || invalid,
            onClick: () => void save(),
          }, busy ? t('saving') : t('save'))))
    }

    /**
     * 插件配置页签里的卡片壳（与官方 PluginCard 同形态）：
     * 标题行可点击展开/折叠；折叠时表单保持挂载（hidden），草稿不丢。
     */
    function Image2DrawCard(props) {
      const { t } = props
      const [open, setOpen] = useState(false)
      const [dirty, setDirty] = useState(false)
      return h('li', { className: `dsh-i2-card${open ? ' dsh-i2-card-open' : ''}` },
        h('button', {
          type: 'button',
          className: 'dsh-i2-card-header',
          'aria-expanded': open,
          'aria-label': `${open ? t('collapse') : t('expand')}: ${t('nav')}`,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'dsh-i2-card-headtext' },
            h('span', { className: 'dsh-i2-card-name' }, t('nav')),
            h('span', { className: 'dsh-i2-card-desc' }, t('cardDesc'))),
          dirty ? h('span', { className: 'dsh-i2-card-pending' }, t('unsaved')) : null,
          h('svg', {
            width: 14, height: 14,
            className: `dsh-i2-card-chevron${open ? ' dsh-i2-card-chevron-open' : ''}`,
            viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
          },
            h('path', {
              d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
              fill: 'currentColor',
            }))),
        h('div', { className: 'dsh-i2-card-body', hidden: !open },
          h(Image2DrawForm, { ...props, onDirtyChange: setDirty })))
    }

    function toolArgsOf(block) {
      const raw = block?.call?.argsRaw ?? block?.argsRaw
      if (typeof raw !== 'string' || raw === '') return {}
      try {
        return objectOf(JSON.parse(raw))
      } catch {
        return {}
      }
    }

    function imageAttachmentsOf(block) {
      const images = []
      for (const content of Array.isArray(block?.content) ? block.content : []) {
        if (content?.type === 'image' && content.attachment !== undefined) images.push(content.attachment)
        if (content?.type !== 'text' || typeof content.text !== 'string') continue
        const pattern = /<!-- image2-attachments-base64:([A-Za-z0-9+/=]+) -->/g
        for (const match of content.text.matchAll(pattern)) {
          try {
            const binary = atob(match[1])
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
            const parsed = JSON.parse(new TextDecoder().decode(bytes))
            if (!Array.isArray(parsed)) continue
            for (const image of parsed) {
              if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
                images.push(image)
              }
            }
          } catch {
            // Ignore malformed markers and let the card fall back to text.
          }
        }
        const legacyPattern = /<!-- image2-attachments:(\[[^\r\n]*\]) -->/g
        for (const match of content.text.matchAll(legacyPattern)) {
          try {
            const parsed = JSON.parse(match[1])
            if (!Array.isArray(parsed)) continue
            for (const image of parsed) {
              if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
                images.push(image)
              }
            }
          } catch {
            // Keep cards from older plugin revisions best-effort compatible.
          }
        }
      }
      const unique = new Map(images.map(image => [image.attachmentId, image]))
      return [...unique.values()]
    }

    function imageExtension(mediaType) {
      if (String(mediaType).includes('jpeg') || String(mediaType).includes('jpg')) return 'jpg'
      if (String(mediaType).includes('webp')) return 'webp'
      return 'png'
    }

    function attachmentUrlOf(attachment) {
      const query = new URLSearchParams({
        id: String(attachment.attachmentId ?? ''),
        mediaType: String(attachment.mediaType ?? ''),
        bytes: String(attachment.bytes ?? ''),
        width: String(attachment.width ?? ''),
        height: String(attachment.height ?? ''),
      })
      return `/image2-draw/attachment?${query.toString()}`
    }

    function imageMetaOf(attachments, args) {
      const firstAttachment = attachments[0]
      const dimensions = Number.isInteger(firstAttachment?.width) && Number.isInteger(firstAttachment?.height)
        ? `${firstAttachment.width}×${firstAttachment.height}`
        : (typeof args?.size === 'string' ? args.size : '')
      return `${attachments.length} 张${dimensions === '' ? '' : ` · ${dimensions}`}`
    }

    function imageFilenameOf(attachment, index) {
      const declared = typeof attachment?.name === 'string' ? attachment.name.trim() : ''
      return declared !== '' ? declared : `image2-${index + 1}.${imageExtension(attachment?.mediaType)}`
    }

    function Image2ToolView(props) {
      const { block, resolveImage, toolName } = props
      const done = block?.kind !== undefined
      const attachments = imageAttachmentsOf(block)
      const args = toolArgsOf(block)
      const [cells, setCells] = useState([])
      const [lightbox, setLightbox] = useState(null)

      useEffect(() => {
        if (!done || typeof resolveImage !== 'function') {
          setCells([])
          return undefined
        }
        setCells(attachments.map(() => ({})))
        let cancelled = false
        attachments.forEach((attachment, index) => {
          resolveImage(attachment).then((url) => {
            if (cancelled) return
            setCells(previous => {
              const next = previous.slice()
              next[index] = { url }
              return next
            })
          }).catch((error) => {
            if (cancelled) return
            setCells(previous => {
              const next = previous.slice()
              next[index] = { error: messageOf(error) }
              return next
            })
          })
        })
        return () => { cancelled = true }
      }, [done, resolveImage, block])

      useEffect(() => {
        if (lightbox === null || typeof window === 'undefined') return undefined
        const closeOnEscape = (event) => { if (event.key === 'Escape') setLightbox(null) }
        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
      }, [lightbox])

      const title = toolName === 'image2-edit' ? 'Image2 图生图' : 'Image2 文生图'
      if (!done) {
        return h('div', { className: 'dsh-i2-result-card' },
          h('div', { className: 'dsh-i2-result-head' },
            h('strong', null, title),
            h('span', { className: 'dsh-i2-result-meta' }, '生成中')),
          typeof args.prompt === 'string'
            ? h('p', { className: 'dsh-i2-result-prompt' }, args.prompt)
            : null,
          h('div', { className: 'dsh-i2-result-running' },
            h('span', { className: 'dsh-i2-result-spinner', 'aria-hidden': true }),
            '正在等待图片接口返回'))
      }

      const text = (Array.isArray(block?.content) ? block.content : [])
        .filter(content => content?.type === 'text' && typeof content.text === 'string')
        .map(content => content.text)
        .join('\n')
      if (attachments.length === 0) {
        return h('div', { className: 'dsh-i2-result-card' },
          h('div', { className: 'dsh-i2-result-head' },
            h('strong', null, title),
            h('span', { className: 'dsh-i2-result-meta' }, block?.isError ? '失败' : '无图片')),
          h('p', { className: 'dsh-i2-result-error' }, text || '工具没有返回可显示的图片附件'))
      }

      const active = lightbox === null ? undefined : cells[lightbox]
      const meta = imageMetaOf(attachments, args)
      return h('div', { className: 'dsh-i2-result-card' },
        h('div', { className: 'dsh-i2-result-head' },
          h('strong', null, title),
          h('span', { className: 'dsh-i2-result-meta' }, meta)),
        typeof args.prompt === 'string'
          ? h('p', { className: 'dsh-i2-result-prompt' }, args.prompt)
          : null,
        h('div', { className: 'dsh-i2-result-grid' },
          ...attachments.map((attachment, index) => {
            const cell = cells[index]
            const filename = imageFilenameOf(attachment, index)
            const preview = cell?.url !== undefined
              ? h('button', {
                type: 'button',
                className: 'dsh-i2-result-cell',
                onClick: () => setLightbox(index),
                title: '查看大图',
              }, h('img', {
                className: 'dsh-i2-result-thumb',
                src: cell.url,
                alt: typeof args.prompt === 'string' ? args.prompt : `Image2 图片 ${index + 1}`,
                onError: () => setCells(previous => {
                  const next = previous.slice()
                  next[index] = { error: 'preview-load-failed' }
                  return next
                }),
              }))
              : h('div', {
                className: cell?.error ? 'dsh-i2-result-cell dsh-i2-result-cell-error' : 'dsh-i2-result-cell dsh-i2-result-cell-loading',
              }, cell?.error ? '预览加载失败' : '加载中')
            return h('div', {
              className: 'dsh-i2-result-item',
              key: attachment.attachmentId ?? index,
            },
            preview,
            h('div', { className: 'dsh-i2-result-file-row' },
              h('span', { className: 'dsh-i2-result-filename', title: filename }, filename),
              cell?.url !== undefined
                ? h('a', {
                    className: 'dsh-i2-result-download',
                    href: cell.url,
                    download: filename,
                  }, '另存为')
                : null))
          })),
        active?.url !== undefined
          ? h('div', {
              className: 'dsh-i2-result-overlay',
              role: 'dialog',
              'aria-modal': true,
              'aria-label': 'Image2 图片预览',
              onClick: () => setLightbox(null),
            },
            h('button', {
              type: 'button',
              className: 'dsh-i2-result-close',
              'aria-label': '关闭预览',
              onClick: event => { event.stopPropagation(); setLightbox(null) },
            }, '×'),
            h('img', {
              className: 'dsh-i2-result-full',
              src: active.url,
              alt: typeof args.prompt === 'string' ? args.prompt : 'Image2 图片',
            }))
          : null)
    }

    function registerImageToolViews(ctx) {
      for (const key of ['image2-generate', 'image2-edit']) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key,
          inject: () => ({
            resolveImage: attachment => Promise.resolve(attachmentUrlOf(attachment)),
          }),
        }, Image2ToolView))
      }
    }

    /* ----------------------------- 样式 ----------------------------- */

    const css = `
      /* 卡片壳：值与官方 PluginCard.module.css 完全一致（类名改 dsh-i2- 前缀） */
      .dsh-i2-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
      .dsh-i2-card:hover{border-color:var(--dsw-alias-label-dimmed)}
      .dsh-i2-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
      .dsh-i2-card-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
      .dsh-i2-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
      .dsh-i2-card-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
      .dsh-i2-card-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
      .dsh-i2-card-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-card-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
      .dsh-i2-card-chevron-open{transform:rotate(180deg)}
      .dsh-i2-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0 8px}
      .dsh-i2-card-body[hidden]{display:none}
      .dsh-i2-card-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
      .dsh-i2-form{display:flex;flex-direction:column;gap:12px;max-width:520px}
      .dsh-i2-fields{display:flex;flex-direction:column;gap:12px}
      .dsh-i2-field{display:flex;flex-direction:column;gap:5px}
      .dsh-i2-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-i2-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-i2-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;letter-spacing:0}
      .dsh-i2-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
      .dsh-i2-input-invalid{border-color:var(--dsw-alias-label-error)}
      .dsh-i2-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-hint,.dsh-i2-invalid{margin:0;font-size:12px;line-height:18px}
      .dsh-i2-hint{color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-invalid{color:var(--dsw-alias-label-error)}
      .dsh-i2-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
      .dsh-i2-badge-ok{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground)}
      .dsh-i2-error,.dsh-i2-success,.dsh-i2-muted{margin:0;font-size:12px;line-height:18px}
      .dsh-i2-error{color:var(--dsw-alias-label-error)}
      .dsh-i2-success{color:var(--dsw-alias-state-success-primary)}
      .dsh-i2-muted{color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:4px}
      .dsh-i2-save,.dsh-i2-secondary{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
      .dsh-i2-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
      .dsh-i2-secondary{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
      .dsh-i2-save:disabled,.dsh-i2-secondary:disabled{opacity:.4;cursor:default}
      .dsh-i2-save:focus-visible,.dsh-i2-secondary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-i2-result-card{box-sizing:border-box;max-width:720px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-module-platform);display:flex;flex-direction:column;gap:10px}
      .dsh-i2-result-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dsh-i2-result-meta{font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .dsh-i2-result-prompt,.dsh-i2-result-error{margin:0;font-size:12px;line-height:18px;word-break:break-word}
      .dsh-i2-result-prompt{color:var(--dsw-alias-label-secondary);max-height:54px;overflow:hidden}
      .dsh-i2-result-error{color:var(--dsw-alias-label-error)}
      .dsh-i2-result-running{display:flex;align-items:center;gap:7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-result-spinner{box-sizing:border-box;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-i2-spin .9s linear infinite}
      @keyframes dsh-i2-spin{to{transform:rotate(360deg)}}
      .dsh-i2-result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,248px));gap:10px}
      .dsh-i2-result-item{display:flex;flex-direction:column;gap:6px;min-width:0}
      .dsh-i2-result-cell{box-sizing:border-box;width:100%;appearance:none;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);min-width:0;aspect-ratio:1/1;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px}
      button.dsh-i2-result-cell{cursor:zoom-in}
      button.dsh-i2-result-cell:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-i2-result-cell-loading,.dsh-i2-result-cell-error{display:flex;align-items:center;justify-content:center;padding:8px;text-align:center}
      .dsh-i2-result-cell-error{color:var(--dsw-alias-label-error)}
      .dsh-i2-result-thumb{display:block;width:100%;height:100%;aspect-ratio:1/1;object-fit:cover}
      .dsh-i2-result-file-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
      .dsh-i2-result-filename{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:28px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2-result-download{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-decoration:none}
      .dsh-i2-result-download:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
      .dsh-i2-result-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:32px;background:rgba(8,10,16,.82);cursor:zoom-out}
      .dsh-i2-result-full{display:block;max-width:92vw;max-height:86vh;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5)}
      .dsh-i2-result-close{position:absolute;top:16px;right:20px;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font:inherit;font-size:20px;line-height:1;cursor:pointer}
      .dsh-i2-result-close:hover{background:rgba(255,255,255,.26)}
    `
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = css
      style.dataset.plugin = 'dsh-image2-draw'
      document.head.appendChild(style)
    }

    /* ------------------------------ apply ------------------------------ */

    const inject = ['slots', 'locale', 'connection', 'remote']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('settings.image2Draw', { zh, en }), 'image2-draw: locale')
      const connection = ctx.get('connection')
      const t = ctx.locale.bind('settings.image2Draw')
      // 注册到 设置 → 插件 → 插件配置（可配置插件页签）的卡片列表。
      // keyed 槽位 settings.plugin.item 以 settings 命名空间为 key（宿主要求 options.key，缺则加载失败）。
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'image2-draw',
        id: 'image2-draw',
        order: 30,
        locale: 'settings.image2Draw',
        inject: () => ({ api: connection.api, remote: ctx.remote, t }),
      }, Image2DrawCard))
      registerImageToolViews(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      draftsOf,
      dirtyOf,
      attachmentUrlOf,
      imageFilenameOf,
      imageMetaOf,
      isValidBaseUrl,
      isValidTimeout,
      imageAttachmentsOf,
      keyRefOf,
      opsFor,
      savePlan,
      toolArgsOf,
    }
    return module.exports
  },
})
