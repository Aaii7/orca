// FlatList (native and web) honours `strictMode` at runtime; React Native's bundled types omit it.
declare module 'react-native' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface.
  interface FlatListProps<ItemT> {
    /** Memoizes the item renderer so a cell re-renders only when its item or `renderItem` changes. */
    strictMode?: boolean
  }
}

export {}
