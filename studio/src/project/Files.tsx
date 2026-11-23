import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { errMsg } from '../api.ts'
import { useAdmin, useCan } from './context.ts'
import type { Bucket, FileEntry } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, toast } from '../ui.tsx'
import { fmtDate, fmtSize, rich, t } from '../i18n/index.ts'

/** Admin API listing cap (core/src/admin/files.ts passes limit 1000). */
const LIST_CAP = 1000

export default function Files() {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [bucketsErr, setBucketsErr] = useState('')
  const [bucket, setBucket] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [newPublic, setNewPublic] = useState(false)
  const [tick, setTick] = useState(0)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    setBucketsErr('')
    let live = true
    api.buckets().then((b) => {
      if (!live) return
      setBuckets(b)
      setBucket((cur) => (cur && b.some((x) => x.id === cur) ? cur : b[0]?.id ?? null))
    }, (e) => live && setBucketsErr(errMsg(e)))
    return () => { live = false }
  }, [tick])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const b = await api.createBucket(newId.trim(), newPublic)
      toast(t('files.created', { id: b.id }))
      setNewId('')
      setBucket(b.id)
      setTick((n) => n + 1)
    } catch (err) { toast(errMsg(err), 'error') }
  }

  return (
    <div className="split">
      <aside className="subnav" aria-label={t('files.buckets')}>
        <div className="subnav-head"><div className="subnav-title">{t('files.buckets')}</div></div>
        {bucketsErr ? <ErrorBox message={bucketsErr} onRetry={() => setTick((n) => n + 1)} />
          : !buckets ? <Loading />
          : !buckets.length ? <Empty>{t('files.none')}</Empty>
          : (
            <ul className="list">
              {buckets.map((b) => (
                <li key={b.id}>
                  <button className={b.id === bucket ? 'active' : undefined} onClick={() => setBucket(b.id)} aria-current={b.id === bucket}>
                    <Icon name="folder" size={14} />
                    <span className="list-name">{b.id}</span>
                    {b.public && <span className="badge">{t('files.public')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        {canWrite && <form className="new-bucket" onSubmit={create}>
          <input aria-label={t('files.newName')} placeholder={t('files.newPlaceholder')} className="mono" required value={newId} onChange={(e) => setNewId(e.target.value)} />
          <label className="check"><input type="checkbox" checked={newPublic} onChange={(e) => setNewPublic(e.target.checked)} />{t('files.publicCheck')}</label>
          <button className="btn sm"><Icon name="plus" size={14} />{t('files.create')}</button>
        </form>}
      </aside>
      {bucket ? <BucketView key={bucket} bucket={bucket} /> : <section className="page-main">{buckets && <Empty>{t('files.pick')}</Empty>}</section>}
    </div>
  )
}

function BucketView({ bucket }: { bucket: string }) {
  const [prefix, setPrefix] = useState('')
  // each entry carries its full object path from the listing that produced it, so actions never mix prefixes
  const [items, setItems] = useState<(FileEntry & { path: string })[] | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [tick, setTick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const reload = () => setTick((n) => n + 1)
  const api = useAdmin()
  const canWrite = useCan()('project.write')

  useEffect(() => {
    setError('')
    setItems(null)
    let live = true // a slow listing of a folder we already left must not land here
    api.files(bucket, prefix).then(
      (list) => live && setItems(list.map((f) => ({ ...f, path: prefix + f.name }))),
      (e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [bucket, prefix, tick])

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    try {
      for (const f of Array.from(files)) await api.upload(bucket, prefix + f.name, f)
      toast(files.length === 1 ? t('files.uploaded', { name: files[0].name }) : t('files.uploadedMany', { n: files.length }))
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ''
      reload()
    }
  }

  const remove = async ({ path }: { path: string }) => {
    if (!(await confirmDanger(t('files.deleteConfirm'), rich('files.deleteMsg', { path: <code>{bucket}/{path}</code> })))) return
    try {
      await api.deleteFile(bucket, path)
      toast(t('files.deleted'))
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const parts = prefix.split('/').filter(Boolean)

  return (
    <section className="page-main">
      <div className="toolbar">
        <nav className="crumbs" aria-label={t('files.path')}>
          <button className="link" onClick={() => setPrefix('')}>{bucket}</button>
          {parts.map((p, i) => (
            <span key={i}>
              <span className="muted"> / </span>
              <button className="link" onClick={() => setPrefix(parts.slice(0, i + 1).join('/') + '/')}>{p}</button>
            </span>
          ))}
        </nav>
        <div className="spacer" />
        <button className="icon-btn" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}><Icon name="refresh" /></button>
        {canWrite && <>
          <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} aria-label={t('files.toUpload')} />
          <button className="btn primary" onClick={() => input.current?.click()} disabled={uploading}>
            <Icon name="upload" />{t(uploading ? 'files.uploading' : 'files.upload')}
          </button>
        </>}
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !items ? <Loading />
          : !items.length ? <Empty>{t(prefix ? 'files.folderEmpty' : 'files.bucketEmpty')}</Empty>
          : (
            <>
            {items.length >= LIST_CAP && (
              <div className="note list-cap" role="note">{t('files.cap', { n: LIST_CAP })}</div>
            )}
            <div className="grid-wrap">
              <table className="grid list-table">
                <thead>
                  <tr>
                    <th><div className="th-btn">{t('common.name')}</div></th>
                    <th><div className="th-btn">{t('common.size')}</div></th>
                    <th><div className="th-btn">{t('files.type')}</div></th>
                    <th><div className="th-btn">{t('files.updated')}</div></th>
                    <th><div className="th-btn"><span className="sr-only">{t('common.actions')}</span></div></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((f) => f.id === null ? (
                    <tr key={'d' + f.name} className="clickable" onClick={() => setPrefix(f.path + '/')}>
                      <td colSpan={5}>
                        <button className="link file-name" onClick={(e) => { e.stopPropagation(); setPrefix(f.path + '/') }}>
                          <Icon name="folder" size={14} />{f.name}/
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={'f' + f.name}>
                      <td><span className="file-name"><Icon name="file" size={14} /><span className="mono">{f.name}</span></span></td>
                      <td className="num small">{fmtSize(f.metadata?.size)}</td>
                      <td className="mono small muted">{f.metadata?.mimetype ?? '—'}</td>
                      <td className="small">{fmtDate(f.updated_at)}</td>
                      <td>
                        <div className="row-actions end">
                          <a className="icon-btn" href={api.fileUrl(bucket, f.path)} download={f.name} aria-label={t('files.downloadOf', { name: f.name })} title={t('files.download')}>
                            <Icon name="download" />
                          </a>
                          {canWrite && <button className="icon-btn danger" onClick={() => remove(f)} aria-label={t('files.deleteOf', { name: f.name })} title={t('common.delete')}><Icon name="trash" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
      </div>
    </section>
  )
}
