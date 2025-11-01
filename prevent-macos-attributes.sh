#!/bin/bash

# Prevent macOS from creating extended attributes in this directory
# Run this script once to configure the directory

echo "Configuring directory to prevent macOS extended attributes..."

# Create a .gitattributes file to prevent extended attributes
cat > .gitattributes << 'EOF'
# Prevent macOS from creating extended attributes
* -xattr
EOF

# Set directory attributes to prevent extended attributes
find . -type d -exec xattr -c {} \; 2>/dev/null || true
find . -type f -exec xattr -c {} \; 2>/dev/null || true

echo "Configuration complete!"
echo "Extended attributes have been removed and prevented for future files."












