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

    /* ------------------------------------------------------------------ *
     * Image2 生图工作台（conversation.input.dock）
     * 模式：文生图 / 图生图 / 多视角人物（2~8 张不同视角参考图，保持同一人物）
     * 素材上传 → /image2-draw/studio/upload；提交 → /studio/submit 后台任务，
     * 轮询 /studio/status；结果图经 /studio/file?session=&name=<token> 展示。
     * ------------------------------------------------------------------ */

    const STUDIO_MAX_FILES = 8
    const STUDIO_MAX_FILE_BYTES = 4 * 1024 * 1024
    const STUDIO_ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
    const STUDIO_SIZE_CHOICES = [
      { value: 'adaptive', label: '自适应' },
      { value: 'auto', label: 'auto' },
      { value: '1024x1024', label: '1024×1024' },
      { value: '1536x1024', label: '1536×1024 横' },
      { value: '1024x1536', label: '1024×1536 竖' },
      { value: '3840x2160', label: '3840×2160' },
    ]
    const STUDIO_QUALITY_CHOICES = ['low', 'medium', 'high', 'auto']
    const CHARACTER_HINT = '上传同一人物 2~8 张不同视角的照片（正面 / 侧面 / 全身 / 不同服装等），AI 会保持人物外观一致地按你的描述生成新图。'

    function StudioChip(props) {
      const { active, onPick, children, title } = props
      return h('button', {
        type: 'button',
        className: active ? 'dsh-i2s-chip dsh-i2s-chip-on' : 'dsh-i2s-chip',
        title: title ?? '',
        onClick: onPick,
      }, children)
    }

    function StudioSection(props) {
      const { label, children } = props
      return h('div', { className: 'dsh-i2s-section' },
        h('div', { className: 'dsh-i2s-section-label' }, label),
        children)
    }

    /** 通用图片上传卡片：上传到 host 临时区，返回 {id,name,url}。 */
    function StudioUploader(props) {
      const { sessionId, files, onFilesChange } = props
      const inputRef = useRef(null)
      const [uploading, setUploading] = useState(0)

      const addFiles = useCallback(async (fileList) => {
        const picked = Array.from(fileList ?? []).filter(file => STUDIO_ACCEPT.includes(String(file.type).toLowerCase()))
        if (picked.length === 0) {
          onFilesChange({ error: '仅支持 PNG / JPEG / WebP 图片' })
          return
        }
        const room = STUDIO_MAX_FILES - files.length
        if (picked.length > room) {
          onFilesChange({ error: `最多 ${STUDIO_MAX_FILES} 张参考图（当前已有 ${files.length} 张）` })
          return
        }
        const oversized = picked.find(file => file.size > STUDIO_MAX_FILE_BYTES)
        if (oversized !== undefined) {
          onFilesChange({ error: `单张图片超过 4MB（${oversized.name}）` })
          return
        }
        setUploading(count => count + picked.length)
        const added = []
        for (const file of picked) {
          const item = {
            localName: file.name,
            url: URL.createObjectURL(file),
            uploadId: undefined,
            state: 'uploading',
            error: '',
          }
          added.push(item)
          onFilesChange({ append: item })
          try {
            const response = await fetch(`/image2-draw/studio/upload?session=${encodeURIComponent(sessionId ?? 'shared')}&name=${encodeURIComponent(file.name)}`, {
              method: 'POST',
              body: file,
            })
            let payload
            try {
              payload = await response.json()
            } catch {
              payload = undefined
            }
            if (response.status !== 200 || payload?.ok !== true) {
              throw new Error(payload?.error?.message ?? `上传失败（HTTP ${response.status}）`)
            }
            onFilesChange({ updateUploadId: { item, id: payload.value.id } })
          } catch (error) {
            onFilesChange({ updateUploadId: { item, id: undefined, error: messageOf(error) } })
          } finally {
            setUploading(count => count - 1)
          }
        }
      }, [sessionId, files.length, onFilesChange])

      const removeFile = useCallback((item) => {
        if (typeof item?.url === 'string') URL.revokeObjectURL(item.url)
        onFilesChange({ remove: item })
      }, [onFilesChange])

      const onDrop = useCallback((event) => {
        event.preventDefault()
        if (event.dataTransfer?.files) void addFiles(event.dataTransfer.files)
      }, [addFiles])

      const input = h('input', {
        ref: inputRef,
        type: 'file',
        multiple: true,
        accept: 'image/png,image/jpeg,image/webp',
        style: { display: 'none' },
        onChange: event => {
          const list = event.target.files
          if (list && list.length > 0) void addFiles(list)
          event.target.value = ''
        },
      })

      const tiles = files.map((item, index) => h('div', { className: 'dsh-i2s-thumb-wrap', key: `${item.localName}-${index}` },
        h('img', { className: 'dsh-i2s-thumb', src: item.url, alt: item.localName }),
        item.state === 'uploading'
          ? h('div', { className: 'dsh-i2s-thumb-veil' }, '上传中…')
          : item.error !== ''
            ? h('div', { className: 'dsh-i2s-thumb-veil dsh-i2s-thumb-error', title: item.error }, '上传失败')
            : null,
        h('button', {
          type: 'button',
          className: 'dsh-i2s-thumb-remove',
          title: `移除 ${item.localName}`,
          'aria-label': `移除 ${item.localName}`,
          onClick: () => removeFile(item),
        }, '×'),
        h('div', { className: 'dsh-i2s-thumb-name', title: item.localName }, item.localName)))

      return h('div', { className: 'dsh-i2s-uploader' },
        h('div', {
          className: 'dsh-i2s-dropzone',
          role: 'button',
          tabIndex: 0,
          onClick: () => inputRef.current?.click(),
          onKeyDown: event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              inputRef.current?.click()
            }
          },
          onDragOver: event => event.preventDefault(),
          onDrop,
        },
          h('span', { className: 'dsh-i2s-drop-icon', 'aria-hidden': true }, '🖼'),
          h('div', { className: 'dsh-i2s-drop-text' },
            h('strong', null, '点击选择或拖拽图片到此处'),
            h('small', null, `PNG / JPEG / WebP · 单张 ≤4MB · 共 ${files.length}/${STUDIO_MAX_FILES} 张${uploading > 0 ? ` · 上传中 ${uploading} 张` : ''}`))),
        input,
        tiles.length > 0 ? h('div', { className: 'dsh-i2s-thumbs' }, ...tiles) : null)
    }

    function Image2StudioDock(props) {
      const { sessionId } = props
      const [open, setOpen] = useState(false)
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])
      return h('div', { className: 'dsh-i2s-dock' },
        h('button', {
          type: 'button',
          className: `dsh-i2s-header${open ? ' dsh-i2s-header-open' : ''}`,
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'dsh-i2s-header-icon', 'aria-hidden': true }, '🎨'),
          h('span', { className: 'dsh-i2s-header-text' },
            h('span', { className: 'dsh-i2s-header-title' }, 'Image2 生图工作台'),
            h('span', { className: 'dsh-i2s-header-desc' }, open ? 'ESC 或右上角「收起」可最小化' : '文生图 · 图生图 · 多视角人物一致生成')),
          h('span', { className: 'dsh-i2s-header-toggle', 'aria-hidden': true }, '▾')),
        h('div', { className: 'dsh-i2s-body', hidden: !open },
          h(Image2StudioPanel, { sessionId, onCollapse: () => setOpen(false) })))
    }

    function Image2StudioPanel(props) {
      const { sessionId, onCollapse } = props
      const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'shared'
      const [mode, setMode] = useState('generate')
      const [size, setSize] = useState('adaptive')
      const [quality, setQuality] = useState('low')
      const [count, setCount] = useState(1)
      const [prompt, setPrompt] = useState('')
      const [extra, setExtra] = useState('')
      const [files, setFiles] = useState([])
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [task, setTask] = useState(undefined) // { taskId } 进行中
      const [result, setResult] = useState(undefined)
      const [taskError, setTaskError] = useState('')
      const [model, setModel] = useState('gpt-image-2')

      // 读取已配置模型名用于展示
      useEffect(() => {
        let alive = true
        fetchJson('/image2-draw/state').then(state => {
          if (alive && typeof state?.value?.model === 'string' && state.value.model !== '') setModel(state.value.model)
        }).catch(() => { /* 配置提示由设置页负责 */ })
        return () => { alive = false }
      }, [])

      // 任务轮询
      useEffect(() => {
        if (task === undefined) return undefined
        let alive = true
        let timer = undefined
        const poll = async () => {
          try {
            const value = await fetchJson(`/image2-draw/studio/status?task=${encodeURIComponent(task)}`)
            if (!alive) return
            if (value.status === 'done') {
              setTask(undefined)
              setResult(value.result)
              setTaskError('')
              setNotice('生成完成')
            } else if (value.status === 'failed') {
              setTask(undefined)
              setTaskError(value.error ?? '生成失败')
            } else if (value.status === 'expired') {
              setTask(undefined)
              setTaskError(value.error ?? '任务已过期，请重新提交')
            } else {
              timer = setTimeout(poll, 2200)
            }
          } catch (pollError) {
            if (!alive) return
            setTask(undefined)
            setTaskError(messageOf(pollError))
          }
        }
        void poll()
        return () => { alive = false; if (timer !== undefined) clearTimeout(timer) }
      }, [task])

      const readyUploads = files.filter(item => item.uploadId !== undefined && item.error === '').map(item => item.uploadId)
      const invalidUploads = files.filter(item => item.error !== '' || item.state === 'uploading').length
      const needImages = mode === 'edit' || mode === 'character'
      const canSubmit = !needImages || (files.length > 0 && invalidUploads === 0)

      const submit = async () => {
        if (!canSubmit || task !== undefined) return
        const text = prompt.trim()
        if (text === '') {
          setError('请先填写提示词')
          return
        }
        if (needImages && readyUploads.length === 0) {
          setError(mode === 'character' ? '请先上传同一人物的多张参考图' : '请先上传参考图')
          return
        }
        setError('')
        setNotice('')
        setTaskError('')
        setResult(undefined)
        const body = {
          sessionId: sid,
          mode: mode === 'generate' ? 'generate' : 'edit',
          prompt: text,
          size,
          quality,
        }
        if (mode === 'generate') body.count = count
        else body.images = readyUploads
        try {
          const value = await fetchJson('/image2-draw/studio/submit', body)
          setTask(value.taskId)
          setNotice('已提交，正在生成…')
        } catch (submitError) {
          setError(messageOf(submitError))
        }
      }

      const assembleCharacterPrompt = () => {
        const reference = files.map((_, index) => `参考图 ${index + 1}`).join('、')
        const prefix = `以下${files.length}张参考图（${reference}）是同一个人的不同视角照片，请以这个人物为主体生成新图，严格保持其五官、脸型、身材与发型一致，只改变动作、表情、服装、场景和光线。`
        const requirement = extra.trim()
        setPrompt(requirement === '' ? prefix : `${prefix}\n\n动作与场景要求：${requirement}`)
        setNotice('提示词已组装，可继续编辑')
      }

      const modeTabs = [
        { key: 'generate', label: '文生图', hint: '只凭文字描述生成' },
        { key: 'edit', label: '图生图', hint: '1~8 张参考图重绘' },
        { key: 'character', label: '多视角人物', hint: '多角度照片保持同一人物' },
      ]

      const handleFilesChange = useCallback((action) => {
        if (action === null || typeof action !== 'object') return
        if (typeof action.error === 'string') {
          setError(action.error)
          return
        }
        if (action.append !== undefined) {
          setFiles(previous => [...previous, action.append])
          return
        }
        if (action.remove !== undefined) {
          setFiles(previous => previous.filter(item => item !== action.remove))
          return
        }
        if (action.updateUploadId !== undefined) {
          const { item, id, error } = action.updateUploadId
          setFiles(previous => previous.map(current => current === item
            ? { ...current, uploadId: id, state: id !== undefined ? 'ready' : 'failed', error: error ?? '' }
            : current))
        }
      }, [])

      return h('div', { className: 'dsh-i2s-panel' },
        h('div', { className: 'dsh-i2s-top' },
          h('div', { className: 'dsh-i2s-tabs', role: 'tablist' },
            ...modeTabs.map(tab => h('button', {
              key: tab.key,
              type: 'button',
              role: 'tab',
              'aria-selected': mode === tab.key,
              className: mode === tab.key ? 'dsh-i2s-tab dsh-i2s-tab-on' : 'dsh-i2s-tab',
              onClick: () => {
                setMode(tab.key)
                setError('')
                setNotice('')
              },
              title: tab.hint,
            },
              h('span', { className: 'dsh-i2s-tab-main' }, tab.label),
              h('span', { className: 'dsh-i2s-tab-sub' }, tab.hint)))),
          h('span', { className: 'dsh-i2s-model' }, `模型：${model}`),
          h('button', { type: 'button', className: 'dsh-i2s-collapse', onClick: onCollapse, title: '收起面板（ESC）' }, '收起')),
        h('div', { className: 'dsh-i2s-params' },
          h('div', { className: 'dsh-i2s-param-row' },
            h('span', { className: 'dsh-i2s-param-label' }, '尺寸'),
            h('div', { className: 'dsh-i2s-chips' },
              ...STUDIO_SIZE_CHOICES.map(choice => h(StudioChip, {
                key: choice.value,
                active: size === choice.value,
                onPick: () => {
                  setSize(choice.value)
                  setNotice('')
                },
              }, choice.label)))),
          h('div', { className: 'dsh-i2s-param-row' },
            h('span', { className: 'dsh-i2s-param-label' }, '质量'),
            h('div', { className: 'dsh-i2s-chips' },
              ...STUDIO_QUALITY_CHOICES.map(item => h(StudioChip, {
                key: item,
                active: quality === item,
                onPick: () => setQuality(item),
              }, item)))),
          mode === 'generate'
            ? h('div', { className: 'dsh-i2s-param-row' },
                h('span', { className: 'dsh-i2s-param-label' }, '张数'),
                h('div', { className: 'dsh-i2s-chips' },
                  ...[1, 2, 4].map(item => h(StudioChip, {
                    key: item,
                    active: count === item,
                    onPick: () => setCount(item),
                  }, `${item} 张`))))
            : null),
        needImages
          ? h(StudioSection, {
              label: mode === 'character' ? '多视角人物参考图（建议 2~8 张不同角度）' : '参考图（1~8 张）',
            },
            h('p', { className: 'dsh-i2s-hint' }, mode === 'character'
              ? CHARACTER_HINT
              : '可传单张或多张源图：多张时 AI 综合所有参考图内容重绘（OpenAI 多源图语义）'),
            h(StudioUploader, { sessionId: sid, files, onFilesChange: handleFilesChange }))
          : null,
        h(StudioSection, { label: mode === 'generate' ? '画面描述' : '修改 / 生成要求' },
          mode === 'character'
            ? h('div', { className: 'dsh-i2s-extra' },
                h('input', {
                  className: 'dsh-i2s-input',
                  type: 'text',
                  value: extra,
                  placeholder: '动作与场景描述，如：让他穿红色卫衣站在雪地里，双手插兜看向镜头，全身照',
                  onChange: event => setExtra(event.target.value),
                }),
                h('button', { type: 'button', className: 'dsh-i2s-magic', onClick: assembleCharacterPrompt },
                  '✨ 按参考图组装一致性提示词'))
            : null,
          h('textarea', {
            className: 'dsh-i2s-textarea',
            rows: mode === 'character' ? 5 : 4,
            value: prompt,
            placeholder: mode === 'generate'
              ? '描述画面，支持中文；含「竖版 / 横版 / 方图」等词时配合「自适应」尺寸会自动定向'
              : '写清要保留什么、修改什么 / 生成什么（多视角人物：先点上方 ✨ 组装提示词，再补充细节）',
            onChange: event => {
              setPrompt(event.target.value)
              setError('')
            },
          })),
        error !== ''
          ? h('p', { className: 'dsh-i2s-error', role: 'alert' }, error)
          : null,
        taskError !== ''
          ? h('p', { className: 'dsh-i2s-error', role: 'alert' }, taskError)
          : null,
        result !== undefined
          ? h('div', { className: 'dsh-i2s-result' },
              h('div', { className: 'dsh-i2s-result-head' },
                h('strong', null, '生成结果'),
                h('span', { className: 'dsh-i2s-result-meta' },
                  `${result.images.length} 张 · ${result.size} · ${result.quality} · ${result.model}`)),
              h('div', { className: 'dsh-i2s-result-grid' },
                ...result.images.map(image => {
                  const url = `/image2-draw/studio/file?session=${encodeURIComponent(sid)}&name=${encodeURIComponent(image.token)}`
                  return h('div', { className: 'dsh-i2s-result-item', key: image.token },
                    h('img', { className: 'dsh-i2s-result-img', src: url, alt: image.name }),
                    h('div', { className: 'dsh-i2s-result-row' },
                      h('span', { className: 'dsh-i2s-result-name', title: image.name }, image.name),
                      h('a', { className: 'dsh-i2s-result-save', href: url, download: image.name }, '另存为')))
                })),
              h('p', { className: 'dsh-i2s-hint' }, '文件保存在 ~/.dsh/storages/image2-draw/library/（重启后仍可访问）'))
          : null,
        h('div', { className: 'dsh-i2s-footer' },
          notice !== '' ? h('span', { className: 'dsh-i2s-success' }, notice) : null,
          task !== undefined
            ? h('span', { className: 'dsh-i2s-running' },
                h('span', { className: 'dsh-i2s-spinner', 'aria-hidden': true }),
                '生成中（图片接口通常需 30~180 秒，请勿重复提交）')
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-i2s-submit',
            disabled: !canSubmit || task !== undefined,
            onClick: () => void submit(),
          }, task !== undefined ? '生成中…' : '开始生成')))
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

      /* Image2 生图工作台（dsh-i2s-） */
      .dsh-i2s-dock{display:flex;flex-direction:column;gap:8px;min-width:0}
      .dsh-i2s-header{width:100%;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-3);color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;gap:12px;padding:9px 14px;text-align:left;transition:border-color .16s,background .16s,border-radius .16s}
      .dsh-i2s-header:hover{border-color:var(--dsw-alias-label-dimmed)}
      .dsh-i2s-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .dsh-i2s-header-open{border-radius:14px 14px 0 0;border-color:var(--dsw-alias-border-l2);background:linear-gradient(180deg,var(--dsw-alias-bg-layer-3),color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-3)))}
      .dsh-i2s-header-icon{flex:none;width:32px;height:32px;display:grid;place-items:center;font-size:16px;line-height:1;border-radius:9px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent));box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}
      .dsh-i2s-header-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
      .dsh-i2s-header-title{font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
      .dsh-i2s-header-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-i2s-header-toggle{flex:none;width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;transition:transform .18s}
      .dsh-i2s-header-open .dsh-i2s-header-toggle{transform:rotate(180deg);color:var(--dsw-alias-label-primary)}
      .dsh-i2s-body{border:1px solid var(--dsw-alias-border-l2);border-top:0;border-radius:0 0 14px 14px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px;max-height:min(56vh,640px);overflow:auto;animation:dsh-i2s-rise .18s ease-out}
      .dsh-i2s-body[hidden]{display:none}
      @keyframes dsh-i2s-rise{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
      @media (max-height:720px){.dsh-i2s-body{max-height:46vh}}
      @media (prefers-reduced-motion:reduce){.dsh-i2s-body{animation:none}}
      .dsh-i2s-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
      .dsh-i2s-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .dsh-i2s-tabs{display:flex;gap:6px}
      .dsh-i2s-tab{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 12px;transition:border-color .15s,background .15s,color .15s}
      .dsh-i2s-tab:hover{border-color:var(--dsw-alias-label-dimmed)}
      .dsh-i2s-tab-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
      .dsh-i2s-tab-main{font-size:13px;font-weight:600;line-height:1.4}
      .dsh-i2s-tab-sub{font-size:10px;line-height:1.4;opacity:.75}
      .dsh-i2s-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .dsh-i2s-model{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-collapse{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;padding:4px 10px;cursor:pointer}
      .dsh-i2s-collapse:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
      .dsh-i2s-params{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
      .dsh-i2s-param-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .dsh-i2s-param-label{flex:none;width:34px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-i2s-chips{display:flex;flex-wrap:wrap;gap:6px}
      .dsh-i2s-chip{appearance:none;box-sizing:border-box;min-height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;padding:3px 11px;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
      .dsh-i2s-chip:hover{border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}
      .dsh-i2s-chip-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:600}
      .dsh-i2s-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-i2s-section{display:flex;flex-direction:column;gap:6px;min-width:0}
      .dsh-i2s-section-label{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .dsh-i2s-hint,.dsh-i2s-error,.dsh-i2s-success,.dsh-i2s-running{margin:0;font-size:12px;line-height:18px}
      .dsh-i2s-hint{color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-error{color:var(--dsw-alias-label-error);word-break:break-word}
      .dsh-i2s-success{color:var(--dsw-alias-state-success-primary)}
      .dsh-i2s-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;letter-spacing:0}
      .dsh-i2s-input:focus,.dsh-i2s-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
      .dsh-i2s-input::placeholder,.dsh-i2s-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;letter-spacing:0;resize:vertical;min-height:72px}
      .dsh-i2s-extra{display:flex;flex-direction:column;gap:6px;margin-bottom:2px}
      .dsh-i2s-magic{align-self:flex-start;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:4px 12px;cursor:pointer}
      .dsh-i2s-magic:hover{border-color:var(--dsw-alias-brand-primary)}
      .dsh-i2s-uploader{display:flex;flex-direction:column;gap:8px;min-width:0}
      .dsh-i2s-dropzone{box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .15s,background .15s}
      .dsh-i2s-dropzone:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover-solid)}
      .dsh-i2s-dropzone:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-i2s-drop-icon{flex:none;width:36px;height:36px;display:grid;place-items:center;font-size:17px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
      .dsh-i2s-drop-text{display:flex;flex-direction:column;gap:2px;min-width:0}
      .dsh-i2s-drop-text strong{font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
      .dsh-i2s-drop-text small{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-thumbs{display:flex;flex-wrap:wrap;gap:8px}
      .dsh-i2s-thumb-wrap{position:relative;flex:none;width:88px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
      .dsh-i2s-thumb{display:block;width:88px;height:88px;object-fit:cover}
      .dsh-i2s-thumb-veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;line-height:1.4;text-align:center;color:#fff;background:rgba(8,10,16,.55);padding:4px}
      .dsh-i2s-thumb-error{background:rgba(160,40,40,.72);color:#fff}
      .dsh-i2s-thumb-remove{position:absolute;top:3px;right:3px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:rgba(8,10,16,.6);color:#fff;font:inherit;font-size:13px;line-height:1;cursor:pointer}
      .dsh-i2s-thumb-remove:hover{background:rgba(160,40,40,.85)}
      .dsh-i2s-thumb-name{box-sizing:border-box;max-width:88px;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-result{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
      .dsh-i2s-result-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
      .dsh-i2s-result-meta{font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,220px));gap:8px}
      .dsh-i2s-result-item{display:flex;flex-direction:column;gap:4px;min-width:0}
      .dsh-i2s-result-img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
      .dsh-i2s-result-row{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
      .dsh-i2s-result-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-result-save{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;text-decoration:none}
      .dsh-i2s-result-save:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
      .dsh-i2s-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding-top:2px}
      .dsh-i2s-running{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary)}
      .dsh-i2s-spinner{box-sizing:border-box;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-i2s-spin .9s linear infinite}
      @keyframes dsh-i2s-spin{to{transform:rotate(360deg)}}
      .dsh-i2s-submit{appearance:none;border:1px solid transparent;border-radius:9px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;font-weight:600;padding:6px 18px;cursor:pointer}
      .dsh-i2s-submit:hover:not(:disabled){box-shadow:0 2px 12px color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}
      .dsh-i2s-submit:disabled{opacity:.4;cursor:default}
      .dsh-i2s-submit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
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
      // 生图工作台（聊天输入区 dock）：文生图 / 图生图 / 多视角人物
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'image2-studio',
        order: 26,
        inject: (zone) => ({
          sessionId: typeof zone === 'string'
            ? zone
            : objectOf(zone).sessionId ?? objectOf(zone).session?.id ?? undefined,
        }),
      }, Image2StudioDock))
    }

    exports.apply = apply
    exports.inject = inject
    exports.Image2StudioDock = Image2StudioDock
    exports.Image2StudioPanel = Image2StudioPanel
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
