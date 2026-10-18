import { useState, type JSX } from 'react';
import { CharacterGridPage } from './CharacterGridPage.js';
import { CharacterDetailPage } from './CharacterDetailPage.js';

export function CharactersTab(): JSX.Element {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  if (selectedName) {
    return (
      <CharacterDetailPage
        name={selectedName}
        onBack={() => setSelectedName(null)}
      />
    );
  }
  return <CharacterGridPage onOpen={setSelectedName} />;
}
