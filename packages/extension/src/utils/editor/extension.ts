export function addListenerOnPackageEnabled(listener: (pkg: Editor.Interface.PackageInfo) => void) {
  Editor.Package.__protected__.on('enable', listener);
}

export function addListenerOnPackageDisabled(listener: (pkg: Editor.Interface.PackageInfo) => void) {
  Editor.Package.__protected__.on('disable', listener);
}
