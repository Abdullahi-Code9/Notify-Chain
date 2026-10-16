import React, { useState, useEffect, useRef, memo } from 'react';
import { useDebounce } from '../hooks/useDebounce';
import { useEventStore } from '../store/eventStore';
import { filterEvents } from '../utils/eventData';
import type { BlockchainEvent } from '../types/event';

// Highlight matches
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;

  const regex = new RegExp(`(${query})`, 'gi');
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <strong
            key={index}
            style={{ color: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.15)' }}
          >
            {part}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

export const SearchAutocomplete = memo(function SearchAutocomplete({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [localValue, setLocalValue] = useState(value);
  const debouncedSearchTerm = useDebounce(localValue, 300);
  const [suggestions, setSuggestions] = useState<BlockchainEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync internal state with external value changes (if any external changes)
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  useEffect(() => {
    // Close dropdown if search is empty
    if (!debouncedSearchTerm.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    let isMounted = true;
    const fetchSuggestions = async () => {
      setIsLoading(true);
      setIsOpen(true);

      // Simulate async fetching
      await new Promise((resolve) => setTimeout(resolve, 300));

      if (isMounted) {
        const allEvents = useEventStore.getState().events;
        // Get up to 5 matching suggestions based on query, disregarding other filters generally,
        // or passing "all" for them.
        const matches = filterEvents(allEvents, debouncedSearchTerm, 'all', 'all').slice(0, 5);
        setSuggestions(matches);
        setIsLoading(false);
      }
    };

    fetchSuggestions();

    return () => {
      isMounted = false;
    };
  }, [debouncedSearchTerm]);

  // Handle outside click to close suggestions
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalValue(val);
    onChange(val); // Immediately pass up the value to update store
    if (!val.trim()) {
      setIsOpen(false);
    }
  };

  const handleSelect = (event: BlockchainEvent) => {
    // Determine what to use for search field. We can use eventName or eventId
    const targetValue = event.eventName || event.eventId;
    setLocalValue(targetValue);
    onChange(targetValue);
    setIsOpen(false);
  };

  return (
    <div className="search-autocomplete" ref={containerRef} style={{ position: 'relative' }}>
      <input
        id="event-search"
        type="search"
        placeholder="Search events..."
        value={localValue}
        onChange={handleInputChange}
        onFocus={() => {
          if (debouncedSearchTerm.trim()) {
            setIsOpen(true);
          }
        }}
        autoComplete="off"
        style={{ width: '100%' }}
      />

      {isOpen && (
        <div
          className="search-autocomplete__dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            backgroundColor: '#12151c',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
            zIndex: 100,
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {isLoading ? (
            <div style={{ padding: '8px 12px', fontSize: '0.85rem', color: '#9aa0a6' }}>
              Loading suggestions...
            </div>
          ) : suggestions.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {suggestions.map((event) => (
                <li
                  key={event.eventId}
                  onClick={() => handleSelect(event)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    fontSize: '0.85rem',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '4px',
                    }}
                  >
                    <strong>
                      <HighlightMatch
                        text={event.eventName || 'Unknown'}
                        query={debouncedSearchTerm}
                      />
                    </strong>
                    <span style={{ fontSize: '0.75rem', color: '#9aa0a6' }}>
                      <HighlightMatch text={event.eventId} query={debouncedSearchTerm} />
                    </span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#9aa0a6', fontFamily: 'monospace' }}>
                    <HighlightMatch
                      text={event.contractAddress.slice(0, 16) + '...'}
                      query={debouncedSearchTerm}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ padding: '8px 12px', fontSize: '0.85rem', color: '#9aa0a6' }}>
              No suggestions found
            </div>
          )}
        </div>
      )}
    </div>
  );
});
