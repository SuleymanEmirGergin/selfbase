import { Page } from '../org/common.tsx'
import { Empty } from '../ui.tsx'
import { t } from '../i18n/index.ts'

// Wave 6 ships site hosting; until then this screen only says what is coming. No sample data.
export default function Sites() {
  return (
    <Page title={t('nav.sites')} meta={<span className="chip pv-chip">{t('sites.chip')}</span>}>
      <div className="card">
        <Empty icon="g-sites">
          <b>{t('sites.off')}</b>
          <p>{t('sites.text')}</p>
        </Empty>
      </div>
    </Page>
  )
}
