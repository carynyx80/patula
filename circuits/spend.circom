pragma circom 2.0.0;

// Patula shielded pool v2 — multi-asset spend circuit (Phase 1b).
//
// A transaction spends 2 notes and creates 2 notes. Each note holds either SOL
// (asset = 0) or the one token named by the public `assetToken`. Value is
// conserved separately for each asset:
//   solIn + publicAmountSol   == solOut
//   tokIn + publicAmountToken == tokOut
// so a single proof can describe a swap: SOL leaves the pool to buy tokens
// (publicAmountSol < 0, publicAmountToken > 0) or the reverse for a sell.
//
// Note      : commitment = Poseidon(amount, pubKey, blinding, asset)
// Key       : pubKey     = Poseidon(privKey)
// Nullifier : Poseidon(commitment, pathIndex, Poseidon(privKey, commitment, pathIndex))

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/switcher.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;
    component sw[levels];
    component h[levels];
    for (var i = 0; i < levels; i++) {
        sw[i] = Switcher();
        sw[i].L <== i == 0 ? leaf : h[i - 1].out;
        sw[i].R <== pathElements[i];
        sw[i].sel <== bits.out[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
    }
    root <== h[levels - 1].out;
}

template Spend(levels, nIns, nOuts) {
    // ---- public ----
    signal input root;
    signal input publicAmountSol;
    signal input publicAmountToken;
    signal input assetToken;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private ----
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inIsToken[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];
    signal input outIsToken[nOuts];

    component inKey[nIns];
    component inCommit[nIns];
    component inSig[nIns];
    component inNull[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inRange[nIns];
    signal inAsset[nIns];
    signal inTok[nIns];
    var solIn = 0;
    var tokIn = 0;

    for (var i = 0; i < nIns; i++) {
        inIsToken[i] * (inIsToken[i] - 1) === 0;
        inAsset[i] <== inIsToken[i] * assetToken;

        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivateKey[i];

        inCommit[i] = Poseidon(4);
        inCommit[i].inputs[0] <== inAmount[i];
        inCommit[i].inputs[1] <== inKey[i].out;
        inCommit[i].inputs[2] <== inBlinding[i];
        inCommit[i].inputs[3] <== inAsset[i];

        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inPrivateKey[i];
        inSig[i].inputs[1] <== inCommit[i].out;
        inSig[i].inputs[2] <== inPathIndices[i];

        inNull[i] = Poseidon(3);
        inNull[i].inputs[0] <== inCommit[i].out;
        inNull[i].inputs[1] <== inPathIndices[i];
        inNull[i].inputs[2] <== inSig[i].out;
        inNull[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommit[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }
        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inAmount[i];

        inTok[i] <== inAmount[i] * inIsToken[i];
        tokIn += inTok[i];
        solIn += inAmount[i] - inTok[i];
    }

    component outCommit[nOuts];
    component outRange[nOuts];
    signal outAsset[nOuts];
    signal outTok[nOuts];
    var solOut = 0;
    var tokOut = 0;
    for (var i = 0; i < nOuts; i++) {
        outIsToken[i] * (outIsToken[i] - 1) === 0;
        outAsset[i] <== outIsToken[i] * assetToken;

        outCommit[i] = Poseidon(4);
        outCommit[i].inputs[0] <== outAmount[i];
        outCommit[i].inputs[1] <== outPubkey[i];
        outCommit[i].inputs[2] <== outBlinding[i];
        outCommit[i].inputs[3] <== outAsset[i];
        outCommit[i].out === outputCommitment[i];

        outRange[i] = Num2Bits(64);
        outRange[i].in <== outAmount[i];

        outTok[i] <== outAmount[i] * outIsToken[i];
        tokOut += outTok[i];
        solOut += outAmount[i] - outTok[i];
    }

    component same[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            same[k] = IsEqual();
            same[k].in[0] <== inputNullifier[i];
            same[k].in[1] <== inputNullifier[j];
            same[k].out === 0;
            k++;
        }
    }

    solIn + publicAmountSol === solOut;
    tokIn + publicAmountToken === tokOut;

    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmountSol, publicAmountToken, assetToken, extDataHash, inputNullifier, outputCommitment]} = Spend(20, 2, 2);
