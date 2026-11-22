import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, errMsg } from '../api.ts'
import type { Bucket, FileEntry } from '../api.ts'
import { Empty, ErrorBox, Icon, Loading, confirmDanger, fmtDate, fmtSize, toast } from '../ui.tsx'

/** Admin API listing cap (core/src/admin/files.ts passes limit 1000). */
const LIST_CAP = 1000

export default function Files() {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [bucketsErr, setBucketsErr] = useState('')
  const [bucket, setBucket] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [newPublic, setNewPublic] = useState(false)
  const [tick, setTick] = useState(0)

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
      toast(`Bucket oluşturuldu: ${b.id}`)
      setNewId('')
      setBucket(b.id)
      setTick((t) => t + 1)
    } catch (err) { toast(errMsg(err), 'error') }
  }

  return (
    <div className="split">
      <aside className="subnav" aria-label="Bucket'lar">
        <div className="subnav-head"><div className="subnav-title">Bucket'lar</div></div>
        {bucketsErr ? <ErrorBox message={bucketsErr} onRetry={() => setTick((t) => t + 1)} />
          : !buckets ? <Loading />
          : !buckets.length ? <Empty>Henüz bucket yok.</Empty>
          : (
            <ul className="list">
              {buckets.map((b) => (
                <li key={b.id}>
                  <button className={b.id === bucket ? 'active' : undefined} onClick={() => setBucket(b.id)} aria-current={b.id === bucket}>
                    <Icon name="folder" size={14} />
                    <span className="list-name">{b.id}</span>
                    {b.public && <span className="badge">herkese açık</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        <form className="new-bucket" onSubmit={create}>
          <input aria-label="Yeni bucket adı" placeholder="yeni-bucket" className="mono" required value={newId} onChange={(e) => setNewId(e.target.value)} />
          <label className="check"><input type="checkbox" checked={newPublic} onChange={(e) => setNewPublic(e.target.checked)} />Herkese açık</label>
          <button className="btn sm"><Icon name="plus" size={14} />Bucket oluştur</button>
        </form>
      </aside>
      {bucket ? <BucketView key={bucket} bucket={bucket} /> : <section className="page-main">{buckets && <Empty>Soldan bir bucket seçin ya da oluşturun.</Empty>}</section>}
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
  const reload = () => setTick((t) => t + 1)

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
      toast(files.length === 1 ? `Yüklendi: ${files[0].name}` : `${files.length} dosya yüklendi`)
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ''
      reload()
    }
  }

  const remove = async ({ path }: { path: string }) => {
    if (!(await confirmDanger('Dosya silinsin mi?', <><code>{bucket}/{path}</code> kalıcı olarak silinecek.</>))) return
    try {
      await api.deleteFile(bucket, path)
      toast('Dosya silindi')
      reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const parts = prefix.split('/').filter(Boolean)

  return (
    <section className="page-main">
      <div className="toolbar">
        <nav className="crumbs" aria-label="Klasör yolu">
          <button className="link" onClick={() => setPrefix('')}>{bucket}</button>
          {parts.map((p, i) => (
            <span key={i}>
              <span className="muted"> / </span>
              <button className="link" onClick={() => setPrefix(parts.slice(0, i + 1).join('/') + '/')}>{p}</button>
            </span>
          ))}
        </nav>
        <div className="spacer" />
        <button className="icon-btn" onClick={reload} aria-label="Yenile" title="Yenile"><Icon name="refresh" /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} aria-label="Yüklenecek dosyalar" />
        <button className="btn primary" onClick={() => input.current?.click()} disabled={uploading}>
          <Icon name="upload" />{uploading ? 'Yükleniyor…' : 'Yükle'}
        </button>
      </div>
      <div className="grid-area">
        {error ? <ErrorBox message={error} onRetry={reload} />
          : !items ? <Loading />
          : !items.length ? <Empty>{prefix ? 'Bu klasör boş.' : 'Bu bucket boş. Dosya yüklemek için Yükle’ye basın.'}</Empty>
          : (
            <>
            {items.length >= LIST_CAP && (
              <div className="note list-cap" role="note">Bu klasörde gösterilenden fazla öğe var; yalnızca ilk {LIST_CAP} öğe listeleniyor.</div>
            )}
            <div className="grid-wrap">
              <table className="grid list-table">
                <thead>
                  <tr>
                    <th><div className="th-btn">Ad</div></th>
                    <th><div className="th-btn">Boyut</div></th>
                    <th><div className="th-btn">Tür</div></th>
                    <th><div className="th-btn">Güncelleme</div></th>
                    <th><div className="th-btn"><span className="sr-only">İşlemler</span></div></th>
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
                          <a className="icon-btn" href={api.fileUrl(bucket, f.path)} download={f.name} aria-label={`${f.name} indir`} title="İndir">
                            <Icon name="download" />
                          </a>
                          <button className="icon-btn danger" onClick={() => remove(f)} aria-label={`${f.name} sil`} title="Sil"><Icon name="trash" /></button>
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
