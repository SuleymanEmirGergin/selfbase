import { Page } from '../org/common.tsx'
import { Empty } from '../ui.tsx'

// Wave 6 ships site hosting; until then this screen only says what is coming. No sample data.
export default function Sites() {
  return (
    <Page title="Siteler" meta={<span className="chip pv-chip">DALGA 6 · ÖNİZLEME</span>}>
      <div className="card">
        <Empty icon="g-sites">
          <b>Siteler henüz açık değil</b>
          <p>Statik ve SSR sitelerinizi bu projenin yanında yayınlamak Dalga 6 ile gelecek: üretim ve hazırlık ortamları,
            dal başına önizleme adresleri ve anında geri alma.</p>
        </Empty>
      </div>
    </Page>
  )
}
