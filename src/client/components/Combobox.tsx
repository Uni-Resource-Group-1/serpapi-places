import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

interface ComboboxProps {
  id: string;
  label: string;
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}

export function Combobox({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = "Type to filter…",
  disabled = false,
  hint,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-listbox`;
  const selected = options.find((option) => option.value === value);

  const filtered = useMemo(() => {
    const needle = query.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
    if (!needle) return options;
    const normalize = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
    const matches = options
      .map((option, index) => {
        const label = normalize(option.label);
        const hint = normalize(option.hint ?? "");
        const labelStarts = label.startsWith(needle);
        const hintStarts = hint.startsWith(needle);
        if (!label.includes(needle) && !hint.includes(needle)) return null;
        return {
          option,
          index,
          rank: hint === needle ? 0 : label === needle ? 1 : labelStarts ? 2 : hintStarts ? 3 : 4,
        };
      })
      .filter((match): match is { option: ComboOption; index: number; rank: number } => match !== null);
    matches.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return matches.map(({ option }) => option);
  }, [options, query]);

  const safeActive = filtered.length === 0 ? -1 : Math.min(active, filtered.length - 1);

  useEffect(() => {
    setActive((current) => (filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1)));
  }, [filtered.length]);

  const choose = (option: ComboOption) => {
    if (option.value !== value) onChange(option.value);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(filtered.length - 1, open ? current + 1 : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      if (open) {
        event.preventDefault();
        const option = filtered[safeActive];
        if (option && option.value !== value) choose(option);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setQuery("");
      }
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    }
  };

  return (
    <div className="field combo">
      <label htmlFor={id}>{label}</label>
      <div className={`combo__control${open ? " combo__control--open" : ""}`}>
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && safeActive >= 0 ? `${id}-option-${safeActive}` : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoComplete="off"
          disabled={disabled}
          value={open ? query : (selected?.label ?? "")}
          placeholder={open ? placeholder : (selected?.label ?? placeholder)}
          onChange={(event) => {
            setQuery(event.target.value);
                  setActive(0);
            setOpen(true);
          }}
          onFocus={() => {
            
            setOpen(true);
            setQuery("");
            setActive(Math.max(0, options.findIndex((option) => option.value === value)));
          }}
          onClick={() => {
            if (!open) {
              setOpen(true);
              setQuery("");
              
            }
          }}
          onBlur={() => {
            setOpen(false);
            setQuery("");
            
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="combo__toggle"
          tabIndex={-1}
          aria-label={open ? `Hide ${label} options` : `Show ${label} options`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              inputRef.current?.focus();
              setOpen(true);
              setQuery("");
            }
          }}
        >
          ▾
        </button>
        {open ? (
          <ul className="combo__list" id={listId} role="listbox" aria-label={label}>
            {filtered.length === 0 ? (
              <li className="combo__empty" role="presentation">
                No matches
              </li>
            ) : (
              filtered.map((option, index) => (
                <li
                  key={option.value}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={`combo__option${index === safeActive ? " combo__option--active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {option.hint ? <span className="combo__hint">{option.hint}</span> : null}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
