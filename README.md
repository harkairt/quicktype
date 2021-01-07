This fork of quicktype was made to add support for explicit typings, so the analyzer doesn't complain when it is set to
```
analyzer:
  strong-mode:
    implicit-casts: false
    implicit-dynamic: false
```

The initial issue: https://github.com/quicktype/quicktype/issues/1622

Note: I've tested and used it without any options, it probably needs tweaking otherwise.
