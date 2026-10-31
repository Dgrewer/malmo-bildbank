import type { ChangeEvent } from 'react'
import { NO_FILTERS, RIGHTS_TEXT, type Filters, type Rights } from '../catalog/search.ts'

export interface FilterOptions {
  photographers: string[]
  years: string[]
  // Stadsområden, delområden och torg eller parker som bilderna är tagna i.
  places: { label: string; values: string[] }[]
}

interface Props {
  text: string
  filters: Filters
  options: FilterOptions
  onText: (text: string) => void
  onFilters: (filters: Filters) => void
}

export function SearchBar({ text, filters, options, onText, onFilters }: Props) {
  const set = (field: keyof Filters) => (event: ChangeEvent<HTMLSelectElement>) =>
    onFilters({ ...filters, [field]: event.target.value })
  const active = text || JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  return (
    <form className="search-bar" role="search" onSubmit={(event) => event.preventDefault()}>
      <input
        type="search"
        aria-label="Sök"
        placeholder="Sök på taggar, plats, fotograf eller filnamn"
        value={text}
        onChange={(event) => onText(event.target.value)}
      />
      <select aria-label="Fotograf" value={filters.photographer} onChange={set('photographer')}>
        <option value="">Alla fotografer</option>
        {options.photographers.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <select aria-label="Plats" value={filters.place} onChange={set('place')}>
        <option value="">Alla platser</option>
        {options.places.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.values.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <select aria-label="År" value={filters.year} onChange={set('year')}>
        <option value="">Alla år</option>
        {options.years.map((year) => (
          <option key={year}>{year}</option>
        ))}
      </select>
      <select aria-label="Rättigheter" value={filters.rights} onChange={set('rights')}>
        {(Object.keys(RIGHTS_TEXT) as Rights[]).map((value) => (
          <option key={value} value={value}>
            {RIGHTS_TEXT[value]}
          </option>
        ))}
      </select>
      {active && (
        <button
          type="button"
          onClick={() => {
            onText('')
            onFilters(NO_FILTERS)
          }}
        >
          Rensa
        </button>
      )}
    </form>
  )
}
