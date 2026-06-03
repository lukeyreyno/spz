#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "cc/load-spz.h"

#ifdef SPZ_BUILD_EXTENSIONS
#include "semantic-labels-niantic.h"
#include "splat-extensions.h"
#endif

namespace {

void printUsage(const char *prog) {
    std::cerr << "Usage: " << prog
              << " <input.ply> <labels.bin> <output.spz> [channelCount=8]\n"
              << "\n"
              << "Loads Gaussian attributes from <input.ply>, reads one uint8 semantic\n"
              << "label per gaussian from <labels.bin> (raw bytes, exactly numPoints long),\n"
              << "attaches them via the SPZ_NIANTIC_semantic_labels extension, and writes\n"
              << "<output.spz>. Each byte packs up to 8 boolean channels (bit i = channel i);\n"
              << "channelCount (1..8) records how many bits are meaningful.\n";
}

// Reads the entire file into a byte buffer. Returns false on failure.
bool readBinaryFile(const std::string &path, std::vector<uint8_t> *out) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) {
        std::cerr << "Error: cannot open '" << path << "'" << std::endl;
        return false;
    }
    const std::streamsize size = in.tellg();
    if (size < 0) {
        std::cerr << "Error: cannot determine size of '" << path << "'" << std::endl;
        return false;
    }
    in.seekg(0, std::ios::beg);
    out->resize(static_cast<size_t>(size));
    if (size > 0 &&
        !in.read(reinterpret_cast<char *>(out->data()), size)) {
        std::cerr << "Error: failed to read '" << path << "'" << std::endl;
        return false;
    }
    return true;
}

}  // namespace

int main(int argc, char *argv[]) {
#ifndef SPZ_BUILD_EXTENSIONS
    (void)argc;
    (void)argv;
    std::cerr << "Error: this tool requires the SPZ library to be built with "
                 "-DSPZ_BUILD_EXTENSIONS=ON" << std::endl;
    return 1;
#else
    if (argc < 4 || argc > 5) {
        printUsage(argv[0]);
        return 1;
    }

    const std::string plyPath = argv[1];
    const std::string binPath = argv[2];
    const std::string spzPath = argv[3];

    uint8_t channelCount = 8;
    if (argc == 5) {
        const long parsed = std::strtol(argv[4], nullptr, 10);
        if (parsed < 1 || parsed > 8) {
            std::cerr << "Error: channelCount must be in range 1..8 (got " << argv[4]
                      << ")" << std::endl;
            return 1;
        }
        channelCount = static_cast<uint8_t>(parsed);
    }

    try {
        // Load the Gaussian attributes from the PLY.
        spz::UnpackOptions unpackOptions;
        spz::GaussianCloud splat = spz::loadSplatFromPly(plyPath, unpackOptions);

        // Load the per-gaussian semantic labels.
        std::vector<uint8_t> labels;
        if (!readBinaryFile(binPath, &labels)) {
            return 1;
        }

        if (labels.size() != static_cast<size_t>(splat.numPoints)) {
            std::cerr << "Error: label count (" << labels.size()
                      << ") does not match number of gaussians (" << splat.numPoints
                      << ")" << std::endl;
            return 1;
        }

        // Bits at index >= channelCount must be zero per the extension spec.
        const uint8_t validMask =
            channelCount == 8 ? 0xFFu
                              : static_cast<uint8_t>((1u << channelCount) - 1u);
        size_t outOfRange = 0;
        for (uint8_t label : labels) {
            if (label & ~validMask) {
                ++outOfRange;
            }
        }
        if (outOfRange > 0) {
            std::cerr << "Warning: " << outOfRange << " label(s) have bits set beyond "
                      << "channelCount=" << static_cast<unsigned>(channelCount)
                      << "; those bits will be preserved as-is" << std::endl;
        }

        // Attach the semantic labels extension.
        auto ext = std::make_shared<spz::SpzExtensionSemanticLabelsNiantic>();
        ext->channelCount = channelCount;
        ext->labels = std::move(labels);
        splat.extensions.push_back(std::move(ext));

        // Save the SPZ with the extension embedded in the plaintext header zone.
        spz::PackOptions packOptions;
        if (!spz::saveSpz(splat, packOptions, spzPath)) {
            std::cerr << "Error: failed to write '" << spzPath << "'" << std::endl;
            return 1;
        }

        std::cout << "Wrote " << spzPath << " (" << splat.numPoints
                  << " gaussians, channelCount=" << static_cast<unsigned>(channelCount)
                  << ")" << std::endl;
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }
#endif  // SPZ_BUILD_EXTENSIONS
}
