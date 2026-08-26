# Two study vocabularies separated by `studies.kind`

Native poll/survey studies and usability studies share tables but are distinct vocabularies,
discriminated by `studies.kind`. Widening `authorableStepTypes` to blur them is the recorded
failure mode: every attempt has leaked one vocabulary's steps into the other's authoring UI.
Add a new study shape by extending the discriminator, never by widening the shared lists.
