import React, { useMemo, useState } from 'react'

import Layout from '../components/Layout'
import Seo from '../components/Seo'
import TypewriterText from '../components/common/TypewriterText'
import PageLink from '../components/common/PageLink'

import Form, { AutocompleteSelect, Select } from '../components/common/form'
import Attribution from '../components/common/Attribution'

import timetableData from '../api/timetable.json' // adjust path to wherever timetable.json actually lives

import type { PageProps } from 'gatsby'

interface StationOption {
  label: string
  value: string
}

interface StationDef {
  crs: string
  name: string
  plat_length: number
}

export default function IndexPage({ location: { search } }: PageProps) {
  // timetable.json's `stations` is an array of {crs, name, plat_length},
  // not a dictionary keyed by CRS - map it straight across.
  const autocomplete = useMemo<StationOption[]>(() => {
    const stations = (timetableData as unknown as { stations: StationDef[] }).stations ?? []

    const formattedStations = stations.map((stationInfo) => {
      const crs = stationInfo.crs.toUpperCase()
      return {
        label: `${stationInfo.name} (${crs})`,
        value: crs,
      }
    })

    formattedStations.sort((a, b) => a.label.localeCompare(b.label))

    return formattedStations
  }, [])

  const searchParams = new URLSearchParams(search)
  const stn = searchParams.get('station')
  const type = searchParams.get('type')

  const [BoardSettings, setBoardSettings] = useState({
    station: stn || '',
    type: type || 'infotec-landscape-dmi',
  })

  function ChooseStation(stnOption: StationOption | null) {
    if (!stnOption) return

    setBoardSettings({
      type: BoardSettings.type,
      station: stnOption.value,
    })
  }

  function ChooseDisplay(display: React.ChangeEvent<HTMLSelectElement>) {
    setBoardSettings({
      type: display.target.value,
      station: BoardSettings.station,
    })
  }

  const currentStationValue = autocomplete.find(opt => opt.value === BoardSettings.station) || null

  return (
    <Layout>
      <Seo title="Choose departure board" />
      <main>
        <header>
          <TypewriterText component="h1" className="display" cursor text="Board settings" time={500} />
        </header>
        <article>
          <Form>
            <AutocompleteSelect
              onChange={ChooseStation as any}
              label="Select a station"
              autocompleteOptions={autocomplete}
              value={currentStationValue}
            />
            <Select
              label="Display type"
              options={[
                { value: 'infotec-landscape-dmi', label: 'Infotec landscape DMI' },
                { value: 'daktronics-data-display-dmi', label: 'Daktronics (Data Display) DMI' },
                { value: 'blackbox-landscape-lcd', label: 'Blackbox landscape LCD' },
              ]}
              placeholder="Choose a display"
              onChange={ChooseDisplay as any}
              value={BoardSettings.type}
            />
            <PageLink
              to={BoardSettings.station && BoardSettings.type ? `/board/${BoardSettings.type}?station=${BoardSettings.station}` : undefined}
              style={{ cursor: 'pointer' }}
            >
              Next
            </PageLink>
          </Form>
        </article>
      </main>

      <Attribution />
    </Layout>
  )
}